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
                const cleanNameForMatching = (name: string) => {
                    return name
                        .toLowerCase()
                        .replace(/memo/g, '')
                        .replace(/paper/g, '')
                        .replace(/p(\d+)/g, '$1')
                        .replace(/_/g, ' ')
                        .replace(/\s+/g, ' ')
                        .trim();
                };

                // Find boundaries of the current year section
                let sectionStart = 0;
                for (let k = i; k >= 0; k--) {
                    if (lines[k].match(/## Scrape:/)) {
                        sectionStart = k;
                        break;
                    }
                }
                let sectionEnd = lines.length;
                for (let k = i + 1; k < lines.length; k++) {
                    if (lines[k].match(/## Scrape:/)) {
                        sectionEnd = k;
                        break;
                    }
                }

                // Search for the memo within this year's section
                for (let j = sectionStart; j < sectionEnd; j++) {
                    const lineJ = lines[j];
                    if (lineJ.toLowerCase().includes('memo') && lineJ.includes(`**${currentSubject}**:`)) {
                        const candidateMatch = lineJ.match(/^-\s*\[[ x]\]\s*\*\*([^*]+)\*\*:\s*(.*)/i);
                        if (candidateMatch) {
                            const candidateName = candidateMatch[2];
                            if (cleanNameForMatching(candidateName) === cleanNameForMatching(paperName)) {
                                const memoPathLine = lines[j+1] || '';
                                const memoMatch = memoPathLine.match(/Local: `([^`]+)`/);
                                if (memoMatch) {
                                    memoPath = memoMatch[1];
                                    break;
                                }
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
    let paperNumber = '1';
    const matchPaper = paper_name.match(/Paper\s*(\d+)/i);
    const matchP = paper_name.match(/P(\d+)/i);
    if (matchPaper) {
        paperNumber = matchPaper[1];
    } else if (matchP) {
        paperNumber = matchP[1];
    }

    try {
        const content = fs.readFileSync(ANALYSIS_FILE, 'utf8');
        const outputLines = content.split('\n');

        let paperLineIndex = -1;
        for (let idx = 0; idx < outputLines.length; idx++) {
            const paperTarget = `- [ ] **${subject}**: ${paper_name}`;
            const paperTargetDone = `- [x] **${subject}**: ${paper_name}`;
            if (outputLines[idx].startsWith(paperTarget) || outputLines[idx].startsWith(paperTargetDone)) {
                paperLineIndex = idx;
                break;
            }
        }

        if (paperLineIndex === -1) {
            console.error(`✗ Could not find paper line in analysis file for: ${subject} - ${paper_name}`);
            return;
        }

        // 1. Find paper URL
        let docUrl = '';
        const storageLine = outputLines[paperLineIndex+2] || '';
        const sMatch = storageLine.match(/Storage: `([^`]+)`/);
        if (sMatch) docUrl = sMatch[1];

        // Find boundaries of the current year section
        let sectionStart = 0;
        for (let k = paperLineIndex; k >= 0; k--) {
            if (outputLines[k].match(/## Scrape:/)) {
                sectionStart = k;
                break;
            }
        }
        let sectionEnd = outputLines.length;
        for (let k = paperLineIndex + 1; k < outputLines.length; k++) {
            if (outputLines[k].match(/## Scrape:/)) {
                sectionEnd = k;
                break;
            }
        }

        const cleanNameForMatching = (name: string) => {
            return name
                .toLowerCase()
                .replace(/memo/g, '')
                .replace(/paper/g, '')
                .replace(/p(\d+)/g, '$1')
                .replace(/_/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
        };

        // 2. Find matching memo, its URL, and mark it
        let memoUrl = '';
        let memoLineIndex = -1;
        for (let j = sectionStart; j < sectionEnd; j++) {
            const lineJ = outputLines[j];
            if (lineJ.toLowerCase().includes('memo') && lineJ.includes(`**${subject}**:`)) {
                const candidateMatch = lineJ.match(/^-\s*\[[ x]\]\s*\*\*([^*]+)\*\*:\s*(.*)/i);
                if (candidateMatch) {
                    const candidateName = candidateMatch[2];
                    if (cleanNameForMatching(candidateName) === cleanNameForMatching(paper_name)) {
                        memoLineIndex = j;
                        const storageLineMemo = outputLines[j+2] || '';
                        const sMatchMemo = storageLineMemo.match(/Storage: `([^`]+)`/);
                        if (sMatchMemo) memoUrl = sMatchMemo[1];
                        break;
                    }
                }
            }
        }

        // Seed database
        console.log(`Seeding ${subject} ${year} Paper ${paperNumber}...`);
        console.log(`Paper URL: ${docUrl}`);
        console.log(`Memo URL: ${memoUrl || 'None'}`);
        
        execSync(`npx tsx scripts/seed_extracted_questions.ts "${jsonPath}" "${subject}" ${year} ${paperNumber} "${docUrl}" "${memoUrl || 'NO_MEMO'}"`, { stdio: 'inherit' });

        // 3. Mark as done in markdown
        outputLines[paperLineIndex] = outputLines[paperLineIndex].replace(/^-\s*\[[ x]\]/i, '- [x]');
        if (memoLineIndex !== -1) {
            outputLines[memoLineIndex] = outputLines[memoLineIndex].replace(/^-\s*\[[ x]\]/i, '- [x]');
            console.log(`✓ Marked matching memo line as done.`);
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
