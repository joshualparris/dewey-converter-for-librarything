# Draft: Request to LibraryThing for supported Dewey write-back

**Status: DRAFT ONLY — not sent**

Subject: Request for supported member-book Dewey update API / permission for Dewey Helper

Hello LibraryThing team,

I maintain a free, open-source tool called **Dewey Helper for LibraryThing**:

https://github.com/joshualparris/dewey-converter-for-librarything

The tool is intended for librarians and small libraries that already have their own catalogue in LibraryThing. It works by:

1. importing the member's own LibraryThing export locally in their browser;
2. looking up Dewey candidates from free/open metadata sources;
3. requiring human review;
4. helping the member update their own Dewey Decimal field.

The tool does not currently automate changes to LibraryThing. I understand LibraryThing does not currently expose a supported API for editing member-book records, and I do not want to use scraping or browser automation contrary to LibraryThing's terms.

Would LibraryThing be willing to support either:

- an authenticated API endpoint for updating a member book's Dewey Decimal field by LibraryThing Book ID; or
- written permission for this specific open-source tool to perform narrowly scoped updates to a signed-in member's own Dewey field?

The intended safeguards would be:

- user-initiated only;
- only the signed-in user's own catalogue;
- identified by LibraryThing's unique Book ID, not ISBN;
- Dewey field only unless explicitly expanded later;
- no password collection by the tool;
- conservative rate limits;
- visible preview/review before updates;
- full audit/export of proposed changes;
- easy stop/cancel;
- no crawling of unrelated LibraryThing pages.

If there is an upcoming spreadsheet-import or member-book editing API that would be a better fit, I would be very happy to target that instead.

Thanks for considering it.

Regards,

Joshua Parris
