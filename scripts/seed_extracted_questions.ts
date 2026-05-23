import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

// Load .env.local
const envPath = path.resolve(process.cwd(), '../../.env.local');
if (fs.existsSync(envPath)) dotenv.config({ path: envPath });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('Missing Supabase credentials.');
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    db: { schema: 'visita_scholar' }
});

async function run() {
    const jsonPath = process.argv[2];
    const subjectName = process.argv[3];
    const year = parseInt(process.argv[4], 10);
    const paperNumber = parseInt(process.argv[5], 10);
    const docUrl = process.argv[6];
    const memoUrl = process.argv[7];

    const r2PublicBase = process.env.CLOUDFLARE_PUBLIC_URL || `https://${process.env.CLOUDFLARE_BUCKET}.f3ddf529fe9c02e47f994cc64605eb5a.r2.dev`;

    let formattedDocUrl = docUrl;
    if (docUrl && !docUrl.startsWith('http')) {
        const cleanKey = docUrl.startsWith('past-papers/') ? docUrl : `past-papers/${docUrl}`;
        formattedDocUrl = `${r2PublicBase}/${cleanKey}`;
    }

    let formattedMemoUrl = memoUrl;
    if (memoUrl && memoUrl !== 'NO_MEMO' && memoUrl !== 'null' && !memoUrl.startsWith('http')) {
        const cleanKey = memoUrl.startsWith('past-papers/') ? memoUrl : `past-papers/${memoUrl}`;
        formattedMemoUrl = `${r2PublicBase}/${cleanKey}`;
    } else if (memoUrl === 'NO_MEMO' || memoUrl === 'null' || !memoUrl) {
        formattedMemoUrl = null;
    }

    if (!jsonPath || !subjectName || !year || !paperNumber || !docUrl) {
        console.error('Usage: npx tsx scripts/seed_extracted_questions.ts <jsonPath> <subjectName> <year> <paperNumber> <docUrl> [memoUrl]');
        process.exit(1);
    }

    if (!fs.existsSync(jsonPath)) {
        console.error(`File not found: ${jsonPath}`);
        process.exit(1);
    }

    const rawData = fs.readFileSync(jsonPath, 'utf8');
    const questions = JSON.parse(rawData);

    // 1. Find or create subject
    let { data: subjectData, error: subjectError } = await supabase
        .from('subjects')
        .select('id')
        .eq('name', subjectName)
        .eq('grade_level', 12)
        .single();

    let subjectId = subjectData?.id;

    if (!subjectId) {
        console.log(`Creating subject: ${subjectName}...`);
        const { data: newSubject, error: newSubError } = await supabase
            .from('subjects')
            .insert({ name: subjectName, grade_level: 12, description: `${subjectName} Grade 12` })
            .select('id')
            .single();
        if (newSubError) throw newSubError;
        subjectId = newSubject.id;
    }

    // 2. Find or create past_paper
    let { data: paperData, error: paperError } = await supabase
        .from('past_papers')
        .select('id')
        .eq('subject_id', subjectId)
        .eq('year', year)
        .eq('paper_number', paperNumber)
        .single();

    let pastPaperId = paperData?.id;

    if (!pastPaperId) {
        console.log(`Creating past paper record for ${subjectName} ${year} Paper ${paperNumber}...`);
        const { data: newPaper, error: newPaperError } = await supabase
            .from('past_papers')
            .insert({
                subject_id: subjectId,
                year: year,
                paper_number: paperNumber,
                document_url: formattedDocUrl,
                memo_url: formattedMemoUrl
            })
            .select('id')
            .single();
        if (newPaperError) throw newPaperError;
        pastPaperId = newPaper.id;
    }

    // 3. Insert questions
    console.log(`Inserting ${questions.length} questions into past_paper_questions...`);
    const formattedQuestions = questions.map((q: any) => ({
        past_paper_id: pastPaperId,
        question_number: q.question_number,
        text: q.text,
        type: q.type,
        options: q.options || [],
        answer: q.answer,
        marks: q.marks || 0
    }));

    const { error: insertError } = await supabase
        .from('past_paper_questions')
        .upsert(formattedQuestions, { onConflict: 'past_paper_id,question_number' });

    if (insertError) {
        console.error('✗ Failed to insert questions:', insertError.message);
    } else {
        console.log('✓ Successfully seeded questions to Supabase!');
    }
}

run().catch(console.error);
