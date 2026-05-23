import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const ANALYSIS_FILE = path.resolve(process.cwd(), '../../.reference/PAST-PAPERS-ANALYSIS.md');

function getNextBatch() {
    if (!fs.existsSync(ANALYSIS_FILE)) {
        console.error('PAST-PAPERS-ANALYSIS.md not found.');
        process.exit(1);
    }

    const content = fs.readFileSync(ANALYSIS_FILE, 'utf8');
    const lines = content.split('\n');
    const batch = [];
    let currentSubject = '';
    let currentYear = '';

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Track year/subject from headers like "## Scrape: 2025-May-June"
        const scrapeMatch = line.match(/## Scrape: (\d{4})/);
        if (scrapeMatch) {
            currentYear = scrapeMatch[1];
        }

        // Look for un-ticked papers: "- [ ] **Subject**: Name"
        const paperMatch = line.match(/^- \[ \] \*\*([^*]+)\*\*: (.*)/);
        if (paperMatch) {
            if (!paperMatch[2].toLowerCase().includes('memo')) {
                currentSubject = paperMatch[1];
                const paperName = paperMatch[2];
                const paperPathLine = lines[i+1] || '';
                const paperPathMatch = paperPathLine.match(/Local: `([^`]+)`/);
                
                // Now find the corresponding memo
                let memoPath = '';
                for (let j = i + 1; j < lines.length; j++) {
                    // Stop if we hit the next year's scrape section
                    if (lines[j].match(/## Scrape: (\d{4})/)) break;

                    if (lines[j].includes('- [ ]') && lines[j].toLowerCase().includes('memo') && lines[j].includes(`**${currentSubject}**:`)) {
                        const candidateMatch = lines[j].match(/^- \[ \] \*\*([^*]+)\*\*: (.*)/);
                        if (candidateMatch) {
                            let candidateName = candidateMatch[2];
                            // Remove 'memo' and normalize spaces
                            let candidateCleaned = candidateName.replace(/memo/i, '').replace(/\s+/g, ' ').trim();
                            let paperCleaned = paperName.replace(/\s+/g, ' ').trim();
                            
                            if (candidateCleaned.toLowerCase() === paperCleaned.toLowerCase()) {
                                const memoPathLine = lines[j+1] || '';
                                const memoMatch = memoPathLine.match(/Local: `([^`]+)`/);
                                if (memoMatch) memoPath = memoMatch[1];
                                break;
                            }
                        }
                    }
                }

                if (paperPathMatch) {
                    batch.push({
                        subject: currentSubject,
                        year: currentYear,
                        paper_name: paperName,
                        paper_path: paperPathMatch[1],
                        memo_path: memoPath || 'NO_MEMO'
                    });

                    if (batch.length === 5) break;
                }
            }
        }
    }

    console.log(JSON.stringify(batch));
}

function markAndSeed(jsonPath: string, subject: string, year: string, paper_name: string) {
    // Determine paper number from name
    const match = paper_name.match(/P(\d+)/);
    const paperNumber = match ? match[1] : '1';

    // Seed database
    console.log(`Seeding ${subject} ${year} Paper ${paperNumber}...`);
    try {
        // Find URLs in markdown
        const content = fs.readFileSync(ANALYSIS_FILE, 'utf8');
        let docUrl = '';
        let memoUrl = '';
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(`**${subject}**: ${paper_name}`)) {
                const storageLine = lines[i+2] || '';
                const sMatch = storageLine.match(/Storage: `([^`]+)`/);
                if (sMatch) docUrl = sMatch[1];
            }
            if (lines[i].includes(`**${subject}**: ${paper_name} memo`)) {
                const storageLine = lines[i+2] || '';
                const sMatch = storageLine.match(/Storage: `([^`]+)`/);
                if (sMatch) memoUrl = sMatch[1];
            }
        }

        execSync(`npx tsx scripts/seed_extracted_questions.ts "${jsonPath}" "${subject}" ${year} ${paperNumber} "${docUrl}" "${memoUrl}"`, { stdio: 'inherit' });

        // Mark as done
        const outputLines = content.split('\n');
        for (let i = 0; i < outputLines.length; i++) {
            const paperTarget = `- [ ] **${subject}**: ${paper_name}`;
            const memoTarget = `- [ ] **${subject}**: ${paper_name} memo`;
            const memoTargetCaps = `- [ ] **${subject}**: ${paper_name} Memo`;
            
            if (outputLines[i].startsWith(paperTarget)) {
                outputLines[i] = outputLines[i].replace(paperTarget, `- [x] **${subject}**: ${paper_name}`);
            }
            if (outputLines[i].startsWith(memoTarget)) {
                outputLines[i] = outputLines[i].replace(memoTarget, `- [x] **${subject}**: ${paper_name} memo`);
            }
            if (outputLines[i].startsWith(memoTargetCaps)) {
                outputLines[i] = outputLines[i].replace(memoTargetCaps, `- [x] **${subject}**: ${paper_name} Memo`);
            }
        }
        fs.writeFileSync(ANALYSIS_FILE, outputLines.join('\n'));
        
        console.log(`✓ Marked ${paper_name} as done.`);
    } catch (e: any) {
        console.error(`✗ Failed to seed or mark ${paper_name}:`, e.message);
    }
}

const command = process.argv[2];
if (command === 'next_batch') {
    getNextBatch();
} else if (command === 'mark_and_seed') {
    const jsonPath = process.argv[3];
    const subject = process.argv[4];
    const year = process.argv[5];
    const paperName = process.argv[6];
    markAndSeed(jsonPath, subject, year, paperName);
} else {
    console.error('Unknown command. Use next_batch or mark_and_seed.');
}
