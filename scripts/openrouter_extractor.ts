import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import OpenAI from 'openai';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pdfParse = require('pdf-extraction');
import * as dotenv from 'dotenv';

const envPath = path.resolve(process.cwd(), '../../.env.local');
if (fs.existsSync(envPath)) dotenv.config({ path: envPath });

const openrouter = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY,
  defaultHeaders: {
    'HTTP-Referer': 'http://localhost:3000',
    'X-Title': 'Visita Scholar'
  }
});

const JSON_SCHEMA = `
[
  {
    "question_number": 1,
    "text": "The full text of the question",
    "type": "multiple_choice | open_ended | true_false | short_answer",
    "options": ["A", "B", "C"], // or null if not applicable
    "answer": "The answer or memo response", // or null if NO_MEMO
    "marks": 5 // integer
  }
]
`;

async function parsePdf(filePath: string): Promise<string> {
    if (!fs.existsSync(filePath) || filePath === 'NO_MEMO') return '';
    try {
        const dataBuffer = fs.readFileSync(filePath);
        const parse = pdfParse.default || pdfParse;
        const data = await parse(dataBuffer);
        return data.text;
    } catch (e) {
        console.error('Failed to parse PDF', filePath, e);
        return '';
    }
}

async function extractWithOpenRouter(paperText: string, memoText: string, paperName: string) {
    let model = 'deepseek/deepseek-v4-flash:free';
    const prompt = `
You are an expert exam parser.
I have extracted raw text from a South African DBE past paper and its official memo.
Your job is to align the questions from the paper with the answers from the memo, and output a valid JSON array of objects.

Schema requirement:
${JSON_SCHEMA}

Extract EVERY question you can find. DO NOT group questions. For multiple choice, include the full text of the options in the "options" array.
For answers, copy the memo's answer directly.
If there is NO_MEMO provided, set answer to null.

RAW PAPER TEXT:
---
${paperText.substring(0, 50000)}
---

RAW MEMO TEXT:
---
${memoText.substring(0, 50000)}
---

IMPORTANT: Reply ONLY with valid JSON array. No markdown blocks, no other text.
Ensure the JSON is perfectly valid:
- Do NOT use trailing commas (e.g. [1, 2,] is invalid).
- Escape all newlines in string properties as \\n.
- Escape all double quotes inside string values as \\\".
`;

    try {
        console.log(`Sending ${paperName} to OpenRouter (${model})...`);
        let response = await openrouter.chat.completions.create({
            model: model,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 8192
        });

        let resultText = response.choices[0].message.content || '[]';
        return resultText;
    } catch (err: any) {
        if (err.status === 429 || err.status === 402 || (err.message && (err.message.includes('429') || err.message.includes('402')))) {
            console.log(`Rate limit or quota hit on free model for ${paperName}. Falling back to deepseek/deepseek-v4-flash...`);
            model = 'deepseek/deepseek-v4-flash';
            let response = await openrouter.chat.completions.create({
                model: model,
                messages: [{ role: 'user', content: prompt }],
                max_tokens: 8192
            });
            return response.choices[0].message.content || '[]';
        }
        throw err;
    }
}

function cleanJsonString(str: string) {
    str = str.replace(/^```json/gi, '').replace(/^```/gi, '').replace(/```$/g, '').trim();
    // Remove trailing commas in arrays and objects
    str = str.replace(/,\s*([\]}])/g, '$1');
    return str;
}

async function processBatch() {
    while (true) {
        const batchOutput = execSync('npx tsx scripts/orchestrator_utils.ts next_batch').toString();
        if (!batchOutput.trim()) {
            console.log('No more batches found. Done!');
            break;
        }

        const batch = JSON.parse(batchOutput);
        if (batch.length === 0) {
            console.log('Finished all papers.');
            break;
        }

        for (const paper of batch) {
            console.log(`\n=== Processing ${paper.subject} ${paper.year} ${paper.paper_name} ===`);
            
            const paperText = await parsePdf(paper.paper_path);
            const memoText = await parsePdf(paper.memo_path);

            if (!paperText) {
                console.error(`Skipping ${paper.paper_name} due to empty paper text.`);
                continue;
            }

            let jsonStr = '';
            try {
                jsonStr = await extractWithOpenRouter(paperText, memoText, paper.paper_name);
                jsonStr = cleanJsonString(jsonStr);

                // Verify it parses
                const parsed = JSON.parse(jsonStr);

                // Define output path
                const baseName = path.basename(paper.paper_path, '.pdf');
                const outPath = path.resolve(process.cwd(), `../../.reference/extracted_json/${baseName}.json`);
                
                fs.mkdirSync(path.dirname(outPath), { recursive: true });
                fs.writeFileSync(outPath, JSON.stringify(parsed, null, 2));

                // Mark and seed
                console.log(`Extracted successfully! Seeding to database...`);
                execSync(`npx tsx scripts/orchestrator_utils.ts mark_and_seed "${outPath}" "${paper.subject}" "${paper.year}" "${paper.paper_name}"`, { stdio: 'inherit' });

            } catch (e: any) {
                console.error(`Error processing ${paper.paper_name}:`, e.message);
                if (jsonStr) {
                    const debugPath = path.resolve(process.cwd(), `../../.reference/extracted_json/failed_parse_debug.txt`);
                    fs.mkdirSync(path.dirname(debugPath), { recursive: true });
                    fs.writeFileSync(debugPath, jsonStr);
                    console.log(`Saved failed JSON string for debugging to ${debugPath}`);
                }
            }
        }
    }
}

processBatch().catch(console.error);
