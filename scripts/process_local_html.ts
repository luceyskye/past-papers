import { createClient } from '@supabase/supabase-js';
import * as cheerio from 'cheerio';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import axios from 'axios';

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

const BASE_URL = 'https://www.education.gov.za';
const REFERENCE_DIR = path.resolve(process.cwd(), '../../.reference');
const CATALOG_PATH = path.join(REFERENCE_DIR, 'PAST-PAPERS-ANALYSIS.md');

// If TEST_FILENAME is set, only process that file to verify it works
const TEST_FILENAME = null; // Set to null to process all

async function run() {
    const files = fs.readdirSync(REFERENCE_DIR);
    const htmlFiles = files.filter(f => f.endsWith('.html') && (f.includes('Exam') || f.includes('past') || f.includes('NSC') || f.includes('Supplementary')));

    let catalogEntries = '';

    for (const file of htmlFiles) {
        if (TEST_FILENAME && file !== TEST_FILENAME) continue;

        console.log(`\n===========================================`);
        console.log(`Processing Archive: ${file}`);
        console.log(`===========================================`);

        const sittingName = file.replace('.html', '').replace(/\s+/g, '-').replace(/[^a-zA-Z0-9-]/g, '');
        const localOutputDir = path.join(REFERENCE_DIR, 'papers', sittingName);

        const html = fs.readFileSync(path.join(REFERENCE_DIR, file), 'utf8');
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
                        let fullUrl = relativeLink;
                        if (!fullUrl.startsWith('http')) {
                            // Some links might be rooted, some might be relative
                            if (fullUrl.startsWith('/')) {
                                fullUrl = BASE_URL + fullUrl;
                            } else {
                                fullUrl = BASE_URL + '/' + fullUrl;
                            }
                        }
                        papersToDownload.push({
                            subject: currentSubject,
                            title: rawTitle,
                            url: fullUrl
                        });
                    }
                }
            });
        });

        console.log(`Found ${papersToDownload.length} papers in ${sittingName}.`);

        // To test, we only download 2 files. For production, set to papersToDownload.length
        const DOWNLOAD_LIMIT = TEST_FILENAME ? 2 : papersToDownload.length;

        if (papersToDownload.length > 0) {
            catalogEntries += `\n## Scrape: ${sittingName}\n\n`;
            
            if (!fs.existsSync(localOutputDir)) {
                fs.mkdirSync(localOutputDir, { recursive: true });
            }

            for (let i = 0; i < Math.min(DOWNLOAD_LIMIT, papersToDownload.length); i++) {
                const paper = papersToDownload[i];
                const fileName = `${paper.title.replace(/\s+/g, '_')}.pdf`;
                const subjectDir = path.join(localOutputDir, paper.subject);
                
                if (!fs.existsSync(subjectDir)) {
                    fs.mkdirSync(subjectDir, { recursive: true });
                }

                const localFilePath = path.join(subjectDir, fileName);
                const supabasePath = `${sittingName}/${paper.subject}/${fileName}`;

                console.log(`[${i+1}/${DOWNLOAD_LIMIT}] Downloading: ${paper.subject} - ${fileName}`);
                try {
                    // Check if already downloaded to save time
                    if (fs.existsSync(localFilePath)) {
                        console.log(`✓ Already exists locally: ${localFilePath}`);
                        catalogEntries += `- [ ] **${paper.subject}**: ${paper.title}\n  - Local: \`${localFilePath}\`\n  - Storage: \`past-papers/${supabasePath}\`\n\n`;
                        continue;
                    }

                    const pdfRes = await axios.get(paper.url, {
                        responseType: 'arraybuffer',
                        timeout: 60000,
                        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' }
                    });
                    const buffer = Buffer.from(pdfRes.data);

                    // 1. Save locally
                    fs.writeFileSync(localFilePath, buffer);
                    console.log(`✓ Saved locally: ${localFilePath}`);

                    // 2. Upload to Supabase
                    const { data, error } = await supabase.storage
                        .from('past-papers')
                        .upload(supabasePath, buffer, {
                            contentType: 'application/pdf',
                            upsert: true
                        });

                    if (error) {
                        console.error(`✗ Supabase upload failed:`, error.message);
                    } else {
                        console.log(`✓ Uploaded to Supabase`);
                    }

                    catalogEntries += `- [ ] **${paper.subject}**: ${paper.title}\n  - Local: \`${localFilePath}\`\n  - Storage: \`past-papers/${supabasePath}\`\n\n`;

                } catch (e: any) {
                    console.error(`✗ Failed to download ${fileName}:`, e.message);
                }
            }
        }
    }

    if (catalogEntries) {
        if (!fs.existsSync(CATALOG_PATH)) {
            fs.writeFileSync(CATALOG_PATH, '# Past Papers Analysis\n\n');
        }
        fs.appendFileSync(CATALOG_PATH, catalogEntries);
        console.log(`\n✓ Appended new entries to ${CATALOG_PATH}`);
    }
}

run().catch(console.error);
