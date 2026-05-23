import { GoogleGenAI } from '@google/genai';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

// Load .env.local
const envPath = path.resolve(process.cwd(), '../../.env.local');
if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
} else {
    dotenv.config({ path: path.resolve(process.cwd(), '../../.env') });
}

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
    console.error('Missing GEMINI_API_KEY in .env.local');
    console.error('Please get a free API key from Google AI Studio and add it to your .env.local');
    process.exit(1);
}

const ai = new GoogleGenAI({ apiKey });

async function run() {
    const paperPath = process.argv[2];
    const memoPath = process.argv[3];

    if (!paperPath || !memoPath) {
        console.error('Usage: npx tsx scripts/parse_pdf_to_json.ts <path_to_paper.pdf> <path_to_memo.pdf>');
        process.exit(1);
    }

    if (!fs.existsSync(paperPath) || !fs.existsSync(memoPath)) {
        console.error('One or both PDF files do not exist at the provided paths.');
        process.exit(1);
    }

    console.log(`Uploading paper: ${paperPath}...`);
    let paperFile = await ai.files.upload({ file: paperPath, mimeType: 'application/pdf' });
    while (paperFile.state === 'PROCESSING') {
        await new Promise(r => setTimeout(r, 3000));
        paperFile = await ai.files.get({ name: paperFile.name });
    }
    
    console.log(`Uploading memo: ${memoPath}...`);
    let memoFile = await ai.files.upload({ file: memoPath, mimeType: 'application/pdf' });
    while (memoFile.state === 'PROCESSING') {
        await new Promise(r => setTimeout(r, 3000));
        memoFile = await ai.files.get({ name: memoFile.name });
    }

    console.log('Processing documents using Gemini 2.5 Pro... This may take a minute.');
    
    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.0-flash',
            contents: [
                { fileData: { fileUri: paperFile.uri, mimeType: paperFile.mimeType } },
                { fileData: { fileUri: memoFile.uri, mimeType: memoFile.mimeType } },
                { text: `You are an expert South African DBE curriculum educator. 
Extract all questions from the provided past paper PDF and pair them with their correct answers from the provided memo PDF.
Return the output as a strict JSON array of objects. Each object MUST have the following schema:
- question_number: string
- text: string (the full text of the question)
- type: string ("multiple_choice" or "open_ended")
- options: array of strings (if multiple choice, otherwise empty array)
- answer: string (the correct answer from the memo)
- marks: number (the marks awarded for the question)

Do NOT wrap the JSON in Markdown formatting like \`\`\`json. Return a raw JSON array only.`}
            ]
        });

        let rawText = response.text || '[]';
        // Clean markdown code blocks if the LLM ignores the prompt
        rawText = rawText.replace(/^```json\n?/, '').replace(/```\n?$/, '').trim();

        const outputFileName = path.basename(paperPath, '.pdf') + '_extracted.json';
        const outputPath = path.join(path.dirname(paperPath), outputFileName);

        fs.writeFileSync(outputPath, rawText);
        console.log(`\n✓ Success! Extracted JSON saved to ${outputPath}`);
    } catch (e: any) {
        console.error(`✗ AI Extraction failed:`, e.message);
    }
}

run().catch(console.error);
