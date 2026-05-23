import { createClient } from '@supabase/supabase-js';
import * as cheerio from 'cheerio';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

// Load .env.local from the workspace root
const envPath = path.resolve(process.cwd(), '../../.env.local');
if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
} else {
    dotenv.config({ path: path.resolve(process.cwd(), '../../.env') });
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('Missing Supabase credentials in .env or .env.local');
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const START_URL = 'https://www.education.gov.za/Curriculum/NationalSeniorCertificate(NSC)Examinations/2025MayJuneExamPapers.aspx';
const SITTING_NAME = '2025-May-June';
const LOCAL_OUTPUT_DIR = path.resolve(process.cwd(), '../../.reference/papers', SITTING_NAME);
const CATALOG_PATH = path.resolve(process.cwd(), '../../.reference/PAST-PAPERS-ANALYSIS.md');

// Process all files
const TEST_LIMIT = Infinity;

async function run() {
    console.log(`Fetching examination page: ${START_URL}`);
    const res = await axios.get(START_URL, {
        timeout: 60000,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' }
    });
    const html = res.data;
    const $ = cheerio.load(html);

    const papersToDownload: any[] = [];

    $('table.Normal[id*="_Document_grdDocuments"]').each((_i, table) => {
        const tableId = $(table).attr('id');
        let currentSubject = 'Unknown Subject';

        if (tableId) {
            const match = tableId.match(/(dnn_ctr\d+)_/);
            if (match) {
                const prefix = match[1];
                const titleEl = $(`#${prefix}_dnnTITLE_titleLabel`);
                if (titleEl.length) {
                    currentSubject = titleEl.text().replace(/\s+/g, ' ').trim().replace(/[^a-zA-Z0-9 -]/g, '');
                }
            }
        }

        $(table).find('tr').each((_j, row) => {
            const titleEl = $(row).find('td.TitleCell a');
            const downloadEl = $(row).find('td.DownloadCell a');

            if (titleEl.length > 0 && downloadEl.length > 0) {
                const rawTitle = titleEl.text().replace(/\s+/g, ' ').trim().replace(/[^a-zA-Z0-9 -]/g, '');
                const relativeLink = downloadEl.attr('href');
                if (relativeLink) {
                    papersToDownload.push({
                        subject: currentSubject,
                        title: rawTitle,
                        url: new URL(relativeLink, START_URL).href
                    });
                }
            }
        });
    });

    console.log(`Found ${papersToDownload.length} papers. Processing first ${TEST_LIMIT}...`);
    
    // Ensure directories exist
    if (!fs.existsSync(LOCAL_OUTPUT_DIR)) {
        fs.mkdirSync(LOCAL_OUTPUT_DIR, { recursive: true });
    }

    let catalogEntries = '';

    for (let i = 0; i < Math.min(TEST_LIMIT, papersToDownload.length); i++) {
        const paper = papersToDownload[i];
        const fileName = `${paper.title.replace(/\s+/g, '_')}.pdf`;
        const subjectDir = path.join(LOCAL_OUTPUT_DIR, paper.subject);
        
        if (!fs.existsSync(subjectDir)) {
            fs.mkdirSync(subjectDir, { recursive: true });
        }

        const localFilePath = path.join(subjectDir, fileName);
        const supabasePath = `${SITTING_NAME}/${paper.subject}/${fileName}`;

        console.log(`\n[${i+1}/${TEST_LIMIT}] Downloading: ${paper.subject} - ${fileName}`);
        try {
            const pdfRes = await axios.get(paper.url, {
                responseType: 'arraybuffer',
                timeout: 60000,
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' }
            });
            const buffer = Buffer.from(pdfRes.data);

            // 1. Save locally
            fs.writeFileSync(localFilePath, buffer);
            console.log(`✓ Saved locally: ${localFilePath}`);

            // 2. Upload to Cloudflare R2
            const r2Key = `past-papers/${supabasePath}`;
            const r2Url = `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/r2/buckets/${process.env.CLOUDFLARE_BUCKET}/objects/${encodeURIComponent(r2Key)}`;
            
            try {
                await axios.put(r2Url, buffer, {
                    headers: {
                        'Authorization': `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
                        'Content-Type': 'application/pdf'
                    },
                    maxContentLength: Infinity,
                    maxBodyLength: Infinity
                });
                console.log(`✓ Uploaded to Cloudflare R2: ${r2Key}`);
            } catch (r2Err: any) {
                console.error(`✗ Cloudflare R2 upload failed:`, r2Err.response?.data || r2Err.message);
            }

            const r2PublicBase = process.env.CLOUDFLARE_PUBLIC_URL || `https://${process.env.CLOUDFLARE_BUCKET}.f3ddf529fe9c02e47f994cc64605eb5a.r2.dev`;
            const finalStoragePath = `${r2PublicBase}/${r2Key}`;

            catalogEntries += `- [ ] **${paper.subject}**: ${paper.title}\n  - Local: \`${localFilePath}\`\n  - Storage: \`${finalStoragePath}\`\n\n`;

        } catch (e: any) {
            console.error(`✗ Failed to download ${fileName}:`, e.message);
        }
    }

    // Update catalog
    if (catalogEntries) {
        if (!fs.existsSync(CATALOG_PATH)) {
            fs.writeFileSync(CATALOG_PATH, '# Past Papers Analysis\n\n');
        }
        fs.appendFileSync(CATALOG_PATH, `\n## Scrape: ${SITTING_NAME}\n\n${catalogEntries}`);
        console.log(`\n✓ Appended to ${CATALOG_PATH}`);
    }
}

run().catch(console.error);
