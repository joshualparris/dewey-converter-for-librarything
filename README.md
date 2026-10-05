# Dewey Helper for LibraryThing

**Use it now:** https://dewey-helper.vercel.app

A free, open-source browser tool for librarians and small libraries who want to review Dewey Decimal Classification (DDC) values in a LibraryThing catalogue.

This project is the 2026 successor to the original `dewey-converter-for-librarything` idea. The old workflow depended on OCLC Classify, which was discontinued in 2024, and on automating LibraryThing catalogue edits. The replacement deliberately avoids scraping or automated LibraryThing logins.

## What it does

1. Export your own LibraryThing catalogue as **Tab-Delimited Text** or **JSON**.
2. Open Dewey Helper in your browser and select the export.
3. The app extracts ISBNs locally.
4. When you press **Find Dewey numbers**, it sends batched ISBN searches to the public Open Library Search API.
5. It shows the current LibraryThing DDC beside the best free-data candidate, with a confidence/review status.
6. You can edit suggestions and export the reviewed results as TSV, CSV or JSON.

Your original export is never modified.

## Privacy and safety

- No LibraryThing username or password is required.
- Your catalogue file is parsed in your browser, not uploaded to this project.
- ISBNs are sent to Open Library only after you start a lookup.
- Results are cached locally in your browser to reduce repeat API traffic.
- This project does **not** scrape LibraryThing and does **not** automate catalogue editing.

LibraryThing currently provides user catalogue exports but no supported API for editing members' books. Their terms also prohibit unapproved scraping/automated site access, so Dewey Helper intentionally leaves final catalogue changes to the human librarian.

## Data source

The free version uses [Open Library](https://openlibrary.org/) because it provides open, public book metadata and can return Dewey values when they exist in its records.

Open Library asks apps not to make hundreds of single-book calls. Dewey Helper therefore:

- batches ISBNs into Search API requests;
- waits between network calls;
- caches prior responses locally;
- does not automatically retry unresolved books via high-volume fuzzy searches.

A result is a **cataloguing aid, not an authority record**. DDC can vary by edition, library policy and cataloguing judgement. Review suggestions before applying them.

## LibraryThing export

LibraryThing currently offers Excel, Tab-Delimited Text, JSON and MARC exports. **Tab-Delimited Text is recommended** here because it contains rich catalogue fields and is easy to process without third-party code.

Typical LibraryThing export fields include:

- `Book_Id`
- `Title`
- `Primary_Author`
- `ISBN`
- `ISBNs`
- `Dewey_Decimal`
- `Dewey_Wording`
- `OCLC`
- `Work_id`

The importer is tolerant of common alternative field names.

## Run locally

There is no build process.

```bash
git clone https://github.com/joshualparris/dewey-converter-for-librarything.git
cd dewey-converter-for-librarything
python -m http.server 8000
```

Then open `http://localhost:8000`.

You can also open `index.html` directly, although browsers sometimes apply stricter network rules to local `file://` pages.

## Project principles

- free to use;
- no paid API required;
- no credentials;
- no scraping;
- human review before catalogue changes;
- accessible to non-programmers;
- minimal dependencies;
- respectful API usage.

## Limitations

Open Library does not have a Dewey number for every ISBN. Some records contain multiple DDC values. Those cases are intentionally marked for review rather than silently guessed.

This tool currently does not write data back into LibraryThing. A supported LibraryThing member-book editing API would be the right way to add that in future.

## Licence

MIT. See [LICENSE](LICENSE).

## Disclaimer

Not affiliated with LibraryThing, OCLC, the Dewey Decimal Classification system, the Online Computer Library Center, Open Library or the Internet Archive. Dewey Decimal Classification and DDC are trademarks of OCLC. Metadata quality varies; librarians remain responsible for classification decisions.
