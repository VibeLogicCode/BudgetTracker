/**
 * The help handbook. This is content, not placeholder text, and it lives in one module so it
 * is reviewable as prose and testable by string match — the same reason
 * src/app/(app)/settings/notifications/guides.tsx keeps its copy in a module of its own.
 *
 * Ruling A1 — the audience is strangers who cloned a public repository: an IT-savvy
 * self-hoster, someone who has never seen a CSV, and everyone in between. Nothing here may
 * assume knowledge of the codebase, and nothing here may point a reader at a person to ask.
 * If a behaviour is worth knowing, it is written down on this page.
 *
 * Ruling A2 — mechanics plus ONE suggested routine, and no financial advice. Describe what a
 * screen does and when a person would open it. Never a spending limit, never a savings rate,
 * never an opinion about what a reader should do with their money. The one number this app
 * ever proposes is the median of the reader's own past months, and even that is theirs to
 * apply, which HELP_ROUTINE says out loud.
 *
 * Ruling A8 — no <details> anywhere in this file or on the page that renders it. Print CSS
 * cannot reliably force collapsed <details> open across engines (some hide the closed content
 * with content-visibility, others with display), and the browser's Print-to-PDF IS the
 * printable handbook. Flat sections are what make that work with no toolchain.
 *
 * Every external address is PLAIN TEXT, never a clickable anchor — the guides.tsx rule, which
 * keeps the zero-egress claim trivially auditable. Internal paths are written as plain text too,
 * so the printed page tells a reader where to go rather than offering a dead click on paper.
 *
 * HELP_SECTIONS carries one section per nav section, and the nav href string itself appears in
 * that section's "Where to find it" line. tests/ops/onboarding-coverage.test.ts greps this file
 * for those nine literals: ship a tenth section without documenting it and the suite goes red.
 */

export interface HelpSection {
  id: string;
  title: string;
  body: React.ReactNode;
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted">{children}</p>;
}

function B({ children }: { children: React.ReactNode }) {
  return <strong className="font-semibold text-ink">{children}</strong>;
}

function Heading({ children }: { children: React.ReactNode }) {
  return <p className="text-sm font-semibold text-ink">{children}</p>;
}

/**
 * The "where to find it" line. `path` is rendered as text, not a link: it is the same string
 * the guard test greps for, it survives being printed, and on paper a link is a dead end.
 */
function Where({ path, children }: { path: string; children: React.ReactNode }) {
  return (
    <p className="text-sm text-subtle">
      <B>Where to find it:</B> {children} <code>{path}</code>
    </p>
  );
}

/**
 * Part 1 — the operating rhythm, stated once. Deliberately four steps in dependency order,
 * because the measured gap this page closes is not "which button", it is "in what order".
 */
export const HELP_ROUTINE: HelpSection = {
  id: 'routine',
  title: 'The monthly routine',
  body: (
    <>
      <P>
        This app has no idea what your bank did until you bring the statement to it. Left alone it
        makes no network calls at all, which means it also finds nothing on its own: everything on
        every screen is there because someone imported it. The rhythm below is the one the app is
        built around. It is <B>one suggested rhythm, not a requirement</B> — nothing breaks if you
        import twice a month, once a quarter, or the day each statement lands.
      </P>
      <ol className="list-decimal space-y-3 pl-5 text-sm text-muted">
        <li>
          <B>Once a month, download a statement from each bank.</B> On the bank&rsquo;s website look
          for <B>Export</B>, <B>Download</B> or <B>Download transactions</B>, and choose{' '}
          <B>CSV</B> if it offers a choice of format. A CSV file is a plain text file of rows and
          columns — the same table you are looking at on the bank&rsquo;s site, saved in a shape a
          program can read. A PDF statement will not work here, because a PDF is a picture of a
          table rather than the table itself.
        </li>
        <li>
          <B>Import each file.</B> Pick the account it belongs to, pick the file, read the preview,
          then commit. Nothing is written until you press the commit button, and re-importing a
          file you have already imported is safe: rows that are already in the database are
          detected and skipped rather than added twice.
        </li>
        <li>
          <B>Clear whatever Review flags.</B> Imported rows are categorized automatically where
          the app is confident. Everything else waits in the review queue, and the number beside{' '}
          <B>Review</B> in the menu is how many. Accepting or correcting a row writes a rule for
          that merchant, so this is the step that makes next month&rsquo;s import arrive cleaner.
        </li>
        <li>
          <B>Then look at Budgets.</B> Once the month&rsquo;s rows are in and categorized, the
          limits on that page are measuring something real. What those limits are, and whether you
          set any at all, is entirely yours: the only figure this app ever proposes is the median
          of your own past months, and it is applied only if you press the button that applies it.
        </li>
      </ol>
      <P>
        If you fall behind, the order matters more than the calendar. An account has to exist
        before an import can land in it, and an import has to land before there is anything to
        review. Goals, coverage reminders and reports all read from whatever those steps have
        already brought in, so they stay quiet until they have something to work with.
      </P>
    </>
  ),
};

/**
 * Part 2 — the feature index. One section per nav section, in nav order, then the cross-cutting
 * things that live behind a screen rather than on one, then a short glossary for a reader who
 * has never used a budgeting app.
 */
export const HELP_SECTIONS: HelpSection[] = [
  {
    id: 'dashboard',
    title: 'Dashboard',
    body: (
      <>
        <Where path="/dashboard">first item in the menu, or the app&rsquo;s logo —</Where>
        <P>
          One month at a time: what was spent, what came in, what is left after both, and how the
          month is tracking against whatever limits exist. It is the screen to open right after an
          import, because a wrong figure here is usually a wrong import.
        </P>
        <P>
          The pills at the top right scope the page to one household member. <B>Household</B> shows
          everyone. A few figures deliberately do not change when you switch person — net worth,
          loans, upcoming bills — because an account, a debt or a bill belongs to the household,
          not to whoever happens to be selected. Only transactions carry a person.
        </P>
        <P>
          Cards on this page hide themselves when they have nothing to say. No loans recorded means
          no loans card; no receipts expiring means no reminder. A sparse Dashboard on a new
          install is the app being quiet, not the app being broken.
        </P>
        <P>
          <B>Quick add</B>, at the top of the page and at the top of Transactions, is the fastest
          way to enter cash or an e-transfer by hand: one line, no scrolling, and the account select
          remembers whichever one you used last.
        </P>
        <P>
          A <B>Needs a look</B> card lists this month&rsquo;s unusual charges, duplicate-looking
          charges and subscriptions that went up since last time — the same checks this app has
          always run in the background, now on screen instead of only reaching you by
          notification. Like every other card here, it hides itself when there is nothing to flag.
        </P>
      </>
    ),
  },
  {
    id: 'transactions',
    title: 'Transactions',
    body: (
      <>
        <Where path="/transactions">second in the menu —</Where>
        <P>
          Every line from every account in one table, with what it was spent on and who it belongs
          to. This is where you go to answer a specific question, rather than to see a summary.
        </P>
        <P>
          The filters <B>compose</B>: account, category, person and a text search all narrow at
          once. So &ldquo;nothing matches these filters&rdquo; never means the data is gone — it
          means this combination excludes all of it. Clear one filter at a time to find out which.
          The search box reads notes as well as descriptions, so a word you only wrote in a note
          still finds the row.
        </P>
        <P>
          <B>The amount is fixed.</B> Nothing in the app edits the amount of an imported
          transaction; it stays exactly as the bank sent it. What a row <em>means</em> is fully
          editable: its category, the person it is attributed to, a note, a friendlier display name,
          and how it splits. A <B>split</B> divides one transaction across several categories — one
          shop run that was partly groceries and partly household — and the parts must add up to
          the whole. Renaming a merchant changes only what you see; the bank&rsquo;s own wording is
          kept underneath, so duplicate detection and the categorizer are unaffected.
        </P>
        <P>
          Cash and anything the bank will never send you can be typed in by hand at the bottom of
          the page. Money moving between two of your own accounts should be marked as a{' '}
          <B>transfer</B>, which keeps it out of spending totals while still counting toward each
          account&rsquo;s balance.
        </P>
      </>
    ),
  },
  {
    id: 'review',
    title: 'Review',
    body: (
      <>
        <Where path="/review">third in the menu, with a count beside it when it is not empty —</Where>
        <P>
          Two kinds of row wait here: the ones with no category at all, and the ones the app
          guessed at from the pattern of your past choices without anybody confirming the guess.
          Transfers are left out, because money moving between your own accounts needs no category,
          and so are rows you have split, because a split row is described by its parts. An empty
          queue is the normal resting state, not an achievement to chase.
        </P>
        <P>
          Accepting a guess or correcting it does two things: it categorizes that row, and it
          writes a rule for that merchant so the next one arrives already sorted. Correcting the
          app is therefore how you train it, and a category you correct twice for the same merchant
          usually means the rule wants a different pattern rather than another correction.
        </P>
        <P>
          When several rows share one merchant the page offers to apply your choice to all of them
          and create the rule in one press. <B>Mark as transfer</B> is there for the rows that are
          not spending at all, such as a credit-card payment from a chequing account.
        </P>
      </>
    ),
  },
  {
    id: 'import',
    title: 'Import',
    body: (
      <>
        <Where path="/import">fourth in the menu —</Where>
        <P>
          Upload a statement, read what the app found in it, then commit. The preview counts the
          rows it will add, the ones it recognises as duplicates and the ones it could not read,
          and nothing at all is written to the database until you press the button that writes it.
          Duplicate detection hashes the raw row as the bank wrote it, so re-importing an
          overlapping date range adds only what is genuinely new.
        </P>
        <P>
          Several Canadian bank layouts are built in. Any other bank is a one-time setup through{' '}
          <B>Add a bank</B>: upload a short sample export, tell it which column holds the date, the
          description and the amount, and save the profile for every future import. Editing a
          built-in profile saves a private copy for that account instead of changing the shared
          original. If the dates come out wrong — March 4 read as April 3 — the profile&rsquo;s date
          format does not match the bank&rsquo;s; fix it in the preview and re-read the same file.
        </P>
        <P>
          <B>OFX and QFX files</B> are read directly, alongside CSV. An OFX file carries the
          bank&rsquo;s own id for each transaction, so re-importing an overlapping statement matches
          those rows exactly instead of by comparing amounts and dates. The new <B>RBC, BMO and
          CIBC</B> presets are built from each bank&rsquo;s published export layout rather than
          checked against a real file yet — tell us if one comes out wrong.
        </P>
        <P>
          <B>A joint card can attribute its rows to the right person.</B> If the statement includes
          a column naming the cardholder, point the mapping at it as the <B>cardholder column</B>{' '}
          and the preview lists every card value it found in the file, so you can assign each one to
          a person before committing. Anything left unassigned falls back to the account&rsquo;s
          owner, which is also what happens on a card with no such column: every row lands on the
          owner regardless of who spent it.
        </P>
        <P>
          <B>A mapping you have stopped using can be deactivated instead of deleted</B>, built-in
          ones included. It comes off the import picker and stays off, while every past import that
          used it keeps working — which is the point, since deleting the mapping a year of history
          was read with would leave that history unexplainable. The <B>History</B> card at the
          bottom of the page lists every import with a button that takes one back out again; an undo
          deletes only the transactions no other import also covers.
        </P>
      </>
    ),
  },
  {
    id: 'budgets',
    title: 'Budgets',
    body: (
      <>
        <Where path="/budgets">fifth in the menu —</Where>
        <P>
          A monthly limit per category. A limit you set in March applies to March and to every
          month after it until you change it again, so an ordinary month needs no edits at all —
          the page is for reading, and only occasionally for typing.
        </P>
        <P>
          Limits exist at two levels: the household, and one person on top of that. <B>Copy
          previous month</B> fills in only the categories that have no limit yet, so it never
          overwrites something you typed.
        </P>
        <P>
          Once there are three full calendar months of history, each category can also show a
          suggestion, which is the median of your own past months and nothing else. It is applied
          only when you press. From the seventh of the month onward a budgeted category also shows
          where it is heading if the rest of the month looks like the days so far. Both are
          arithmetic on your own data; neither is a recommendation.
        </P>
        <P>
          Linking a category to a bill (on the bill&rsquo;s own page, under Contracts &amp;
          Coverage) turns its row into a <B>sinking fund</B>: it says what it is accumulating for
          and how much of the bill&rsquo;s amount is carried so far, so a large irregular bill —
          property tax, an annual renewal — stops arriving as a surprise the month it lands.
        </P>
      </>
    ),
  },
  {
    id: 'goals',
    title: 'Goals',
    body: (
      <>
        <Where path="/goals">sixth in the menu —</Where>
        <P>
          What the household is saving towards, and whether the current pace reaches it. Name a
          goal, give it a target amount and optionally a target date, then log each contribution as
          you set the money aside.
        </P>
        <P>
          A goal is a record, not an instruction to a bank: logging a contribution moves no money
          and reads no savings account. It is you telling the app what you did.
        </P>
        <P>
          From the first contribution onward the goal shows its pace, and where a target date
          exists, the monthly amount that would arrive on time. A goal that is finished or
          abandoned is <B>archived</B> rather than deleted, and archived goals can be shown again
          from the button in the header.
        </P>
      </>
    ),
  },
  {
    id: 'coverage',
    title: 'Contracts & Coverage',
    body: (
      <>
        <Where path="/warranties">seventh in the menu —</Where>
        <P>
          One list for everything you keep paperwork on: warranties, subscriptions, contracts,
          loans and bills. Which of the five an entry behaves as comes from its <B>item type</B>,
          and the wording follows — a subscription shows a <B>cancel by</B> date where a warranty
          shows an expiry date. The Dashboard reminds you before a date arrives, which is the
          whole reason to record one.
        </P>
        <P>
          Attach the receipt or the contract as a photo or a PDF. The server reads the text on it,
          so the search box on this page searches <B>every word printed on</B> the document, not
          just the fields you typed. Searching a model number, a store name or a serial you never
          entered will find the item.
        </P>
        <P>
          That reading happens entirely on this machine. The recognition models ship inside the
          app, nothing is uploaded anywhere to interpret a receipt, and it works on an install with{' '}
          <B>no internet connection at all</B>. A photograph taken on a phone is straightened and
          cropped in your browser before it uploads, so a hand-held snap of a long receipt is
          usually readable.
        </P>
        <P>
          A loan recorded here can have real transactions assigned to it from the Transactions
          page, which is what makes the Dashboard&rsquo;s loan card and the debt-over-time report on
          Reports say anything.
        </P>
        <P>
          A loan can point either way. <B>Borrowed — we owe them</B> is the usual one — money
          leaving the account pays it down. <B>Lent out — they owe us</B> is for money you lent
          someone: money leaving the account adds to what they owe you, and money coming back
          takes it off again. Loans you lent out are kept out of the debt figures and get their
          own card on the Dashboard and their own line on the debt report.
        </P>
        <P>
          You don&rsquo;t have to start on this page to record a loan. From the Transactions
          page, a row&rsquo;s menu offers <B>Assign to &lt;loan name&gt;</B> for an
          existing loan — money out on a loan you lent out adds to what they owe, money in
          reduces it — and <B>Assign to new loan…</B>, which creates the loan right there and
          assigns that row as its first entry.
        </P>
        <P>
          A <B>bill</B> is the one kind that carries its own list of due dates rather than a
          repeating cycle — property tax, which falls due two to six times a year on dates the
          municipality picks. Create an item type of kind <B>Bill</B> under{' '}
          <B>Settings → Item types</B> (call it <B>Property tax</B>), add the item, then enter
          each due date and amount in the <B>Installments</B> section on the item&rsquo;s own
          page. The Dashboard&rsquo;s <B>Coming up</B> card lists them, you are reminded before
          each one, and anything that goes past is flagged as overdue until you mark it paid. If
          you add a payment-matching rule, the transaction that pays it marks the next unpaid
          installment for you. Paid by some other means, or want to record it the moment it
          clears? <B>Record payment</B> on the Coming up card or the item&rsquo;s own page writes
          the transaction and marks the installment paid in the same step, and refuses if that
          installment is already marked paid rather than writing it twice.
        </P>
      </>
    ),
  },
  {
    id: 'reports',
    title: 'Reports',
    body: (
      <>
        <Where path="/reports">eighth in the menu —</Where>
        <P>
          Where the money went over a stretch of time rather than in one month: category
          breakdowns, cash flow month by month, the same categories compared month over month and
          against the same month last year, who spent what, the largest merchants, net worth, debt
          over time, and a tax-year view of anything flagged as tax-relevant. Pick a range from the
          presets or set your own dates. <B>Export CSV</B> hands you the rows behind the range.
        </P>
        <P>
          Most panels need a few months of history before they can say anything, and several need
          three. &ldquo;Not enough history yet&rdquo; is those panels being honest, not a fault:
          import older statements and they fill in. A range with no rows in it produces the same
          shape of message for the opposite reason, which is worth checking before you go hunting
          for a missing import.
        </P>
        <P>
          Every figure here is arithmetic over transactions you imported. Nothing on this page is
          advice, and a savings rate shown here is a description of the months in the range.
        </P>
      </>
    ),
  },
  {
    id: 'settings',
    title: 'Settings',
    body: (
      <>
        <Where path="/settings">ninth in the menu, and in the account menu at the top right —</Where>
        <P>
          Two halves. The top of the page is yours: your name and password, your two-factor
          authentication, the button that signs you out everywhere, and your notification
          channels. Notifications stay dormant until someone configures one, and that page carries
          its own step-by-step guides for each channel.
        </P>
        <P>
          Below that, for administrators only, is how the household&rsquo;s data is managed:{' '}
          <B>Users</B> (who can sign in, and what they may change), <B>Bank accounts</B> (where
          imported rows land), <B>Item types</B> (the coverage categories, and which of them behave
          as subscriptions), <B>Categories, merchant rules and import profiles</B> (how a line from
          the bank turns into something with a name and a category), <B>Backups</B>, and{' '}
          <B>Connections</B> for optional bank sync.
        </P>
        <P>
          <B>Bank accounts is the first thing to set up</B>, because every import needs an account
          to land in: one entry per real account you export from — chequing, credit card, cash.
          Accounts are deactivated rather than deleted, since the transactions and import history
          pointing at them have to keep working. The version of the app you are running is at the
          very bottom of this page, along with the log of what changed in each release.
        </P>
        <P>
          Two more account types cover what a chequing-and-credit household cannot enter:{' '}
          <B>savings</B> behaves like a chequing account but is left out of safe-to-spend, and{' '}
          <B>asset</B> — a house, a TFSA, an RRSP — holds only a balance you type in yourself and
          counts toward net worth. Neither takes an import or a transaction.
        </P>
        <Heading>Someone&rsquo;s own view</Heading>
        <P>
          On <B>Settings → Users</B>, an admin can set anyone to <B>Only their own records</B>.
          From then on that person sees the transactions attributed to them, their own budgets,
          goals and items, and their own upcoming bills — and nothing else. No account balances, no
          net worth, no household totals, and no other member&rsquo;s rows. It is the right setting
          for a child&rsquo;s account. It is not a way to run two families on one install:
          categories, merchant rules and the classifier are shared by everyone here, so a second
          household needs its own container (see INSTALL.md).
        </P>
        <Heading>People who do not sign in</Heading>
        <P>
          The same page can add someone as a <B>person only</B> — no password, no sign-in. They
          show up wherever you choose who a transaction was for, and nowhere else. Useful for a
          young child or a relative living with you.
        </P>
        <P>
          An <B>audit log</B> at Settings → Audit log lists every deleted item, deleted receipt
          and undone import, with who did it and when.
        </P>
      </>
    ),
  },
  {
    id: 'balances',
    title: 'Balances, and why one can disagree with your bank',
    body: (
      <>
        <Where path="/settings/accounts">
          the <B>Balance</B> column under Settings, then Bank accounts —
        </Where>
        <P>
          The app keeps no running total. A balance is worked out on demand as the{' '}
          <B>newest balance figure on or before that date, plus every transaction</B> recorded
          after that figure and up to the date you asked about. A snapshot, in other words, plus
          the movement since it.
        </P>
        <P>
          A balance figure can come from three places: the bank&rsquo;s own balance column in a
          statement you imported, which is the best of the three, a bank sync, or a number someone
          typed in by hand. Entering a fresh figure re-anchors everything after it, which is why
          this design was chosen — a balance that has drifted corrects itself at the next real
          statement instead of compounding quietly forever.
        </P>
        <P>
          When two consecutive <B>statement balances</B> from the bank do not agree with the
          transactions imported between them, that account is flagged with both dates and the
          amount of the gap. The arithmetic is saying an import is missing rows for that period,
          and the two dates say which statement to go and re-import. The app only reports this. It
          never invents an adjusting transaction to make the numbers agree, because a plug entry
          would hide exactly the problem worth knowing about.
        </P>
      </>
    ),
  },
  {
    id: 'bank-sync',
    title: 'Bank sync is optional',
    body: (
      <>
        <Where path="/settings/connections">Settings, then Connections —</Where>
        <P>
          The app can pull transactions and balances from your bank through SimpleFIN, a bridge you
          set up and control yourself. It is entirely optional and it is off until someone
          configures it: leave that page alone and the app never makes a single network request on
          its behalf.
        </P>
        <P>
          <B>CSV import always works without it.</B> Nothing else in the app requires a connection,
          no feature is degraded by not having one, and a household that never opens that page is
          using the app exactly as intended.
        </P>
        <P>
          Where it is set up, each remote account maps to exactly one account here, a sync brings
          rows in with an overlap window so nothing falls through the gap between runs, and those
          rows go through the same review queue and the same undo path as an imported file.
        </P>
      </>
    ),
  },
  {
    id: 'backups',
    title: 'Backups, and checking that a restore worked',
    body: (
      <>
        <Where path="/settings/backups">Settings, then Backups —</Where>
        <P>
          A <B>nightly</B> job at 02:00 local time writes one archive containing a consistent copy
          of the database and every receipt file, then keeps the most recent few and deletes the
          rest. How many it keeps is a number on that page. <B>Download backup now</B> makes a
          fresh archive and sends it to your browser, which is the one to press before you change
          anything you are nervous about.
        </P>
        <P>
          Archives are not encrypted, which is a deliberate choice for an app that lives on your
          own network. Receipt photographs travel inside them and can show names, addresses and
          partial card numbers, so if copies go somewhere else — another disk, another building —
          turn on encryption in whatever tool makes that copy.
        </P>
        <P>
          To restore, pick a row, tick the confirmation box and press <B>Restore and restart</B>.
          The archive is validated in full before anything is staged; then the app restarts and
          applies the restore before it opens the database, because restoring underneath a live
          database is how databases get corrupted. The page is unreachable for roughly thirty
          seconds. An archive written by a newer version of the app than the one running is
          refused with an explanation: upgrade first, then restore. Older archives restore
          normally.
        </P>
        <P>
          <B>Verifying it worked:</B> refresh the page after the restart and the Backups page{' '}
          <B>shows the outcome of the last restore</B> at the top. Then look at the data itself —
          the newest rows on Transactions, and the import history at the bottom of Import — and
          confirm they match the day the archive was written. The database that was replaced is
          kept beside the live one as a <code>pre-restore</code> copy, so restoring the wrong
          archive costs you a second restore rather than your data.
        </P>
      </>
    ),
  },
  {
    id: 'sharing',
    title: 'Sharing packs',
    body: (
      <>
        <Where path="/settings/managers">
          Settings, then Categories, merchant rules and import profiles —
        </Where>
        <P>
          <B>Sharing packs</B> are small files that carry the work rather than the data. A rules
          pack holds your categories and the merchant rules the categorizer has learned; a
          profiles pack holds the column mappings that read your banks&rsquo; exports.
        </P>
        <P>
          Neither contains a single transaction, amount, balance, receipt, account number or
          person. That is what makes them safe to hand over: another household running this app
          can import your pack and inherit months of categorizing without seeing a cent of your
          money. Rules that mark transfers are held back unless you explicitly include them, and
          you can leave individual rules or profiles out of the export.
        </P>
        <P>
          Importing a pack previews first — how many rules are new, which ones conflict with rules
          you already have, and which categories it would create — and you choose whether a
          conflict keeps your version or takes theirs. A pack is also the tidy way to carry your
          own setup to a fresh install.
        </P>
        <P>
          If what you actually need is to give a real person real numbers, an accountant or a
          co-owner, that is <B>Export CSV</B> on Reports for the date range in question. A pack
          cannot do it, by design.
        </P>
      </>
    ),
  },
  {
    id: 'words',
    title: 'Words this app uses',
    body: (
      <>
        <Heading>Worth knowing before the rest makes sense</Heading>
        <ul className="list-disc space-y-2 pl-5 text-sm text-muted">
          <li>
            <B>CSV</B> — a plain text file of rows and columns, which is how banks offer a
            statement to a program rather than to a person. Spreadsheets open one; so does this
            app.
          </li>
          <li>
            <B>Transaction</B> — one line from a statement: a date, whatever text the bank wrote,
            and an amount. Money out is negative, money in is positive.
          </li>
          <li>
            <B>Merchant</B> — the shop or company behind that text, once the app has tidied the
            reference numbers off it. Rules are learned per merchant, which is why one correction
            can fix a hundred future rows.
          </li>
          <li>
            <B>Category</B> — what a transaction was for. Categories nest one level, so a parent
            such as Food can hold Groceries and Restaurants.
          </li>
          <li>
            <B>Rule</B> — a remembered decision: this merchant means this category. Created for
            you every time you accept or correct a guess.
          </li>
          <li>
            <B>Transfer</B> — money moving between two of your own accounts. It is not spending, so
            it is excluded from spending totals while still affecting both balances.
          </li>
          <li>
            <B>Split</B> — one transaction divided across several categories, with the parts adding
            up to the whole.
          </li>
          <li>
            <B>Mapping</B> or <B>profile</B> — which column of a particular bank&rsquo;s export
            holds the date, the description and the amount. Set up once per bank.
          </li>
          <li>
            <B>Snapshot</B> — a balance recorded for an account on a date. Every balance the app
            shows is the newest snapshot plus the transactions after it.
          </li>
          <li>
            <B>Household</B> — everyone who can sign in here. One administrator creates the
            others; there is no self-registration after the first person.
          </li>
        </ul>
      </>
    ),
  },
];
