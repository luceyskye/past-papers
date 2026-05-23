import { Actor } from 'apify';
import { CheerioCrawler, log } from '@crawlee/cheerio';

interface InputSchema {
    startUrls?: { url: string }[];
    year?: number;
    sitting?: string; // e.g., "May/June" or "November"
}

await Actor.init();

const input = await Actor.getInput<InputSchema>();

const startUrls = input?.startUrls || [
    { url: 'https://www.education.gov.za/Curriculum/NationalSeniorCertificate(NSC)Examinations/2025MayJuneExamPapers.aspx' }
];

const defaultYear = input?.year || 2025;
const defaultSitting = input?.sitting || "May/June";

const crawler = new CheerioCrawler({
    async requestHandler({ request, $, log }) {
        log.info(`Processing ${request.url}...`);
        
        const results: any[] = [];
        
        // Find all DotNetNuke document tables
        $('table.Normal[id*="_Document_grdDocuments"]').each((_i, table) => {
            const tableId = $(table).attr('id');
            let currentSubject = 'Unknown Subject';
            
            // In DNN, the title and the document grid usually share the same module ID
            // e.g., dnn_ctr14211_Document_grdDocuments and dnn_ctr14211_dnnTITLE_titleLabel
            if (tableId) {
                const match = tableId.match(/(dnn_ctr\d+)_/);
                if (match) {
                    const prefix = match[1];
                    const titleEl = $(`#${prefix}_dnnTITLE_titleLabel`);
                    if (titleEl.length) {
                        currentSubject = titleEl.text().replace(/\s+/g, ' ').trim();
                    }
                }
            }

            // Parse rows in the table
            $(table).find('tr').each((_j, row) => {
                const titleEl = $(row).find('td.TitleCell a');
                const downloadEl = $(row).find('td.DownloadCell a');
                
                if (titleEl.length > 0 && downloadEl.length > 0) {
                    const rawTitle = titleEl.text().replace(/\s+/g, ' ').trim();
                    const relativeLink = downloadEl.attr('href');
                    const link = relativeLink ? new URL(relativeLink, request.loadedUrl).href : null;
                    
                    if (link) {
                        const lowerTitle = rawTitle.toLowerCase();
                        
                        // Infer Document Type
                        let documentType = 'Exam Paper';
                        if (lowerTitle.includes('memo')) documentType = 'Memo';
                        else if (lowerTitle.includes('addendum')) documentType = 'Addendum';
                        else if (lowerTitle.includes('errata')) documentType = 'Errata';
                        
                        // Infer Paper Number
                        let paperNum = null;
                        const pMatch = rawTitle.match(/P[1-3]/i);
                        if (pMatch) paperNum = pMatch[0].toUpperCase();
                        
                        // Infer Language Level
                        let languageLevel = null;
                        if (rawTitle.includes(' HL') || lowerTitle.includes('home language')) languageLevel = 'HL';
                        else if (rawTitle.includes(' FAL') || lowerTitle.includes('first additional')) languageLevel = 'FAL';
                        else if (rawTitle.includes(' SAL') || lowerTitle.includes('second additional')) languageLevel = 'SAL';
                        
                        results.push({
                            sourceUrl: request.loadedUrl,
                            year: defaultYear,
                            sitting: defaultSitting,
                            subject: currentSubject,
                            rawTitle,
                            documentType,
                            paperNum,
                            languageLevel,
                            downloadUrl: link
                        });
                    }
                }
            });
        });
        
        await Actor.pushData(results);
        log.info(`Pushed ${results.length} documents from ${request.url}`);
    },
});

await crawler.run(startUrls);

await Actor.exit();
