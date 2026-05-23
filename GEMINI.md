# Past Papers Apify Actor

This actor's primary purpose is to scrape past examination papers and memoranda from the South African Department of Basic Education (DBE) website (`education.gov.za`) and ingest them into the Visita Scholar database.

## Scraping Reference
The DBE website uses a DotNetNuke (DNN) portal structure. The exam papers are presented in HTML tables across different pages for each exam sitting (e.g., "2025 May/June Exam Papers"). 

Key HTML elements to target:
- **Tables**: `table.Normal` with `id` attributes like `dnn_ctrXXXXX_Document_grdDocuments`.
- **Subject Headers**: Groupings usually preceded by header tags containing the subject category (e.g., `<h2><span class="eds_containerTitle">Afrikaans</span></h2>`).
- **Rows**: Each row contains a `TitleCell` and a `DownloadCell`.
- **Titles**: Extracted from `a` tags within `TitleCell` (e.g., "Afrikaans FAL P1" or "Afrikaans FAL P1 memo").
- **Download Links**: Extracted from `a` tags within `DownloadCell` (e.g., `https://www.education.gov.za/LinkClick.aspx?fileticket=...&forcedownload=true`).

## Actor Responsibilities
1. **Navigate & Discover**: Crawl the NSC Examination pages for different years and terms.
2. **Extract & Parse**: Extract document titles and download links from the DNN tables.
3. **Normalize**: Clean the titles to accurately identify:
   - Subject Name
   - Language Level (HL, FAL, SAL)
   - Paper Number (P1, P2, P3)
   - Type (Exam Paper vs. Memo)
4. **Ingest**: Output the structured data so it can be inserted into the Supabase `past_papers` table, mapping to the appropriate `subject_id` and `year`.
