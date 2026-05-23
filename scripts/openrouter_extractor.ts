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
    "question_number": "1.1", // String. MUST be wrapped in double quotes. Do NOT output as a number!
    "text": "The full text of the question",
    "type": "multiple_choice | open_ended", // Use only these two exact values
    "options": ["A", "B", "C"], // array of options (strings) or null if not multiple choice
    "answer": "The answer or memo key", // string, or null if NO_MEMO
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

function normalizeText(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

function getOrigIndex(orig: string, norm: string, normIdx: number): number {
    let normCount = 0;
    let origIdx = 0;
    while (origIdx < orig.length && normCount < normIdx) {
        if (/\s/.test(orig[origIdx])) {
            origIdx++;
        } else {
            normCount++;
            origIdx++;
        }
    }
    return origIdx;
}

async function getSplitsFromAI(paperText: string, memoText: string, paperName: string): Promise<any[]> {
    const paperSample = paperText.substring(0, 35000);
    const memoSample = memoText.substring(0, 35000);
    
    const prompt = `
You are an expert exam parser.
Your task is to identify the main sections or question blocks (e.g., "Section A", "Section B", "Section C", or "Question 1", "Question 2", "Question 3") in the provided exam paper.
For each section, find a unique 15-20 character text snippet from the raw paper text and the raw memo text that marks the exact start of that section.
The snippets MUST appear EXACTLY in the texts (including case, spaces, and punctuation).

RAW PAPER TEXT (First 35k chars):
---
${paperSample}
---

RAW MEMO TEXT (First 35k chars):
---
${memoSample}
---

Output a valid JSON array of objects with the following schema:
[
  {
    "section_name": "Section A",
    "paper_start_snippet": "exact snippet marking the start of Section A in the paper",
    "memo_start_snippet": "exact snippet marking the start of Section A in the memo"
  }
]
Reply ONLY with the valid JSON array. No markdown blocks, no other text.
`;

    let model = 'deepseek/deepseek-v4-flash:free';
    try {
        console.log(`Asking OpenRouter (${model}) to identify sections for ${paperName}...`);
        let response = await openrouter.chat.completions.create({
            model: model,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 1000
        });
        const text = response.choices[0].message.content || '[]';
        return JSON.parse(cleanJsonString(text));
    } catch (err: any) {
        if (err.status === 429 || err.status === 402 || (err.message && (err.message.includes('429') || err.message.includes('402')))) {
            console.log(`Rate limit or quota hit on free model for section splitting. Falling back to deepseek/deepseek-v4-flash...`);
            model = 'deepseek/deepseek-v4-flash';
            let response = await openrouter.chat.completions.create({
                model: model,
                messages: [{ role: 'user', content: prompt }],
                max_tokens: 1000
            });
            const text = response.choices[0].message.content || '[]';
            return JSON.parse(cleanJsonString(text));
        }
        throw err;
    }
}

async function splitExam(paperText: string, memoText: string, paperName: string): Promise<{ name: string, paperChunk: string, memoChunk: string }[]> {
    if (paperText.length <= 40000 && memoText.length <= 40000) {
        console.log(`[Split] ${paperName}: Paper is small enough. Processing in a single chunk.`);
        return [{ name: 'Whole Paper', paperChunk: paperText, memoChunk: memoText }];
    }

    let splits: any[] = [];
    try {
        splits = await getSplitsFromAI(paperText, memoText, paperName);
    } catch (err) {
        console.log(`[Split] ${paperName}: Failed to get splits from AI, fallback to processing whole paper:`, err);
    }

    if (!splits || !Array.isArray(splits) || splits.length <= 1) {
        console.log(`[Split] ${paperName}: No valid section splits found. Processing as whole paper.`);
        return [{ name: 'Whole Paper', paperChunk: paperText, memoChunk: memoText }];
    }

    const normPaper = normalizeText(paperText);
    const normMemo = normalizeText(memoText);
    const normPaperLower = normPaper.toLowerCase();
    const normMemoLower = normMemo.toLowerCase();

    const paperIndices = splits.map(s => {
        const normSnippet = normalizeText(s.paper_start_snippet || '');
        if (!normSnippet) return null;
        const index = normPaperLower.indexOf(normSnippet.toLowerCase());
        return { name: s.section_name, index, snippet: normSnippet };
    }).filter((x): x is { name: string, index: number, snippet: string } => x !== null && x.index !== -1)
      .sort((a, b) => a.index - b.index);

    const memoIndices = splits.map(s => {
        const normSnippet = normalizeText(s.memo_start_snippet || '');
        if (!normSnippet) return null;
        const index = normMemoLower.indexOf(normSnippet.toLowerCase());
        return { name: s.section_name, index, snippet: normSnippet };
    }).filter((x): x is { name: string, index: number, snippet: string } => x !== null && x.index !== -1)
      .sort((a, b) => a.index - b.index);

    if (paperIndices.length <= 1 || memoIndices.length <= 1) {
        console.log(`[Split] ${paperName}: Could not find matching snippets in text (paper matches: ${paperIndices.length}, memo matches: ${memoIndices.length}). Falling back to whole paper.`);
        return [{ name: 'Whole Paper', paperChunk: paperText, memoChunk: memoText }];
    }

    console.log(`[Split] ${paperName}: Splitting paper into ${paperIndices.length} sections based on AI analysis.`);
    const chunks: { name: string, paperChunk: string, memoChunk: string }[] = [];

    const paperOrigIndices = paperIndices.map(x => ({
        name: x.name,
        index: getOrigIndex(paperText, normPaper, x.index)
    })).sort((a, b) => a.index - b.index);

    const memoOrigIndices = memoIndices.map(x => ({
        name: x.name,
        index: getOrigIndex(memoText, normMemo, x.index)
    })).sort((a, b) => a.index - b.index);

    for (let i = 0; i < paperOrigIndices.length; i++) {
        const pStart = paperOrigIndices[i].index;
        const pEnd = i < paperOrigIndices.length - 1 ? paperOrigIndices[i+1].index : paperText.length;
        
        const mSec = memoOrigIndices.find(x => x.name === paperOrigIndices[i].name) || memoOrigIndices[Math.min(i, memoOrigIndices.length - 1)];
        
        let mStart = 0;
        let mEnd = memoText.length;
        if (mSec) {
            const mSecIdx = memoOrigIndices.indexOf(mSec);
            mStart = mSec.index;
            mEnd = mSecIdx < memoOrigIndices.length - 1 ? memoOrigIndices[mSecIdx + 1].index : memoText.length;
        } else if (memoOrigIndices.length > 0) {
            mStart = memoOrigIndices[Math.min(i, memoOrigIndices.length - 1)].index;
            mEnd = i < paperOrigIndices.length - 1 ? (memoOrigIndices[Math.min(i + 1, memoOrigIndices.length - 1)]?.index || memoText.length) : memoText.length;
        }

        chunks.push({
            name: paperOrigIndices[i].name,
            paperChunk: paperText.substring(pStart, pEnd),
            memoChunk: memoText.substring(mStart, mEnd)
        });
    }

    return chunks;
}

async function extractWithOpenRouter(paperText: string, memoText: string, paperName: string) {
    let model = 'deepseek/deepseek-v4-flash:free';
    const prompt = `
You are an expert exam parser.
I have extracted raw text from a section of a South African DBE past paper and its official memo.
Your job is to align the questions from the paper with the answers from the memo, and output a valid JSON array of objects.

Schema requirement:
${JSON_SCHEMA}

Instructions:
1. Extract EVERY question you can find in the provided text.
2. DO NOT group questions together.
3. For multiple choice questions, include the full text of the options in the "options" array.
4. For answers, copy the memo's answer/marking guidelines directly. If NO_MEMO is provided, set answer to null.
5. "question_number" MUST be a string wrapped in double quotes (e.g., "1.1", "4.1.1"). NEVER output a number without quotes.
6. "type" MUST be exactly "multiple_choice" or "open_ended".

RAW PAPER TEXT SECTION:
---
${paperText}
---

RAW MEMO TEXT SECTION:
---
${memoText}
---

IMPORTANT: Reply ONLY with valid JSON array. No markdown blocks, no other text.
Ensure the JSON is perfectly valid:
- Do NOT use trailing commas (e.g. [1, 2,] is invalid).
- Escape all newlines in string properties as \\n.
- Escape all double quotes inside string values as \\\".
- Keep "text" and "answer" properties concise. Summarize long descriptions and options to prevent output token truncation.
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

function repairTruncatedJsonArray(str: string): string {
    str = str.trim();
    if (str.endsWith(']')) return str;

    let openBraces = 0;
    let openBrackets = 0;
    let lastValidEnd = -1;
    let inString = false;
    let escape = false;

    for (let i = 0; i < str.length; i++) {
        const char = str[i];
        if (escape) {
            escape = false;
            continue;
        }
        if (char === '\\') {
            escape = true;
            continue;
        }
        if (char === '"') {
            inString = !inString;
            continue;
        }
        if (!inString) {
            if (char === '{') {
                openBraces++;
            } else if (char === '}') {
                openBraces--;
                if (openBraces === 0 && openBrackets === 1) {
                    lastValidEnd = i;
                }
            } else if (char === '[') {
                openBrackets++;
            } else if (char === ']') {
                openBrackets--;
            }
        }
    }

    if (lastValidEnd !== -1) {
        return str.substring(0, lastValidEnd + 1) + '\n]';
    }

    return str;
}

function cleanJsonString(str: string) {
    str = str.replace(/^```json/gi, '').replace(/^```/gi, '').replace(/```$/g, '').trim();
    str = repairTruncatedJsonArray(str);
    str = str.replace(/,\s*([\]}])/g, '$1');
    return str;
}

async function processPaper(paper: any) {
    console.log(`[Start] ${paper.subject} ${paper.year} ${paper.paper_name}`);
    
    const paperText = await parsePdf(paper.paper_path);
    const memoText = await parsePdf(paper.memo_path);

    if (!paperText) {
        console.error(`[Error] Skipping ${paper.paper_name} due to empty paper text.`);
        return;
    }

    console.log(`[Parsed] ${paper.paper_name}: Paper length: ${paperText.length} chars, Memo length: ${memoText.length} chars.`);

    const chunks = await splitExam(paperText, memoText, paper.paper_name);
    console.log(`[Split] ${paper.paper_name}: Processing ${chunks.length} section chunks...`);

    const allQuestions: any[] = [];
    let chunkIndex = 1;
    for (const chunk of chunks) {
        console.log(`[Chunk ${chunkIndex}/${chunks.length}] ${paper.paper_name} (${chunk.name})`);
        let jsonStr = '';
        try {
            jsonStr = await extractWithOpenRouter(chunk.paperChunk, chunk.memoChunk, `${paper.paper_name} (${chunk.name})`);
            jsonStr = cleanJsonString(jsonStr);

            const parsed = JSON.parse(jsonStr);
            if (Array.isArray(parsed)) {
                allQuestions.push(...parsed);
                console.log(`[Chunk Success] ${paper.paper_name} (${chunk.name}): Extracted ${parsed.length} questions.`);
            } else {
                console.error(`[Error] Parsed JSON from chunk ${chunk.name} is not an array.`);
            }
        } catch (e: any) {
            console.error(`[Error] Processing chunk ${chunk.name} in ${paper.paper_name}:`, e.message);
            if (jsonStr) {
                const debugPath = path.resolve(process.cwd(), `../../.reference/extracted_json/failed_parse_debug.txt`);
                fs.mkdirSync(path.dirname(debugPath), { recursive: true });
                fs.writeFileSync(debugPath, jsonStr);
            }
        }
        chunkIndex++;
    }

    if (allQuestions.length > 0) {
        const baseName = path.basename(paper.paper_path, '.pdf');
        const outPath = path.resolve(process.cwd(), `../../.reference/extracted_json/${baseName}.json`);
        
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, JSON.stringify(allQuestions, null, 2));

        console.log(`[Success] ${paper.paper_name}: Extracted successfully! Total questions: ${allQuestions.length}. Seeding to database...`);
        execSync(`npx tsx scripts/orchestrator_utils.ts mark_and_seed "${outPath}" "${paper.subject}" "${paper.year}" "${paper.paper_name}"`, { stdio: 'inherit' });
    } else {
        console.error(`[Fail] ${paper.paper_name}: Failed to extract any questions.`);
    }
}

async function processBatch() {
    const CONCURRENCY = 3;
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

        console.log(`\n=== Processing batch of ${batch.length} papers with concurrency ${CONCURRENCY} ===`);

        let index = 0;
        const workers = Array.from({ length: CONCURRENCY }, async () => {
            while (index < batch.length) {
                const paper = batch[index++];
                if (!paper) break;
                try {
                    await processPaper(paper);
                } catch (err: any) {
                    console.error(`Fatal error in parallel worker processing ${paper.paper_name}:`, err.message);
                }
            }
        });

        await Promise.all(workers);
    }
}

processBatch().catch(console.error);
