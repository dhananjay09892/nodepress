# Report pages in the admin

A plugin can add a read-only page of numbers to the admin without running code in the browser. `admin.addPage()` takes a `report` next to (or instead of) `panels`:

```ts
admin.addPage({
  id: 'overview',
  title: 'Analytics',
  panels: [], // may be empty when there is a report
  report: {
    route: '/summary', // a route of this plugin that answers JSON
    defaultDays: 30, // range when the page opens (default 30)
    maxDays: 366, // longest range the route accepts (default 366)
    totals: [{ key: 'views', label: 'Page views' }], // numbers in `data.totals`
    chart: {
      title: 'Per day',
      rows: 'days', // an array in the answer
      x: 'day', // each row's `YYYY-MM-DD` label
      series: [{ key: 'views', label: 'Page views' }], // up to 3 bars per day
    },
    tables: [
      {
        rows: 'pages',
        title: 'Top pages',
        columns: [
          { key: 'path', label: 'Page' },
          { key: 'views', label: 'Page views', numeric: true },
        ],
      },
    ],
  },
});
```

The admin asks `GET /api/v1/plugins/<plugin><route>?from=YYYY-MM-DD&to=YYYY-MM-DD` with the signed-in person's session and draws the answer. The route does the permission check (use `capability: 'manage_options'`); the page itself needs the page `capability` (default `manage_options`) to be listed, like any other page. A `400` answer with a `message` shows that message.

- The declaration is validated when the plugin registers it, and a bad one fails only that plugin: `route` must be a path of the plugin (letters, digits, `/`, `_`, `-`, `.`; no query, no `..`, no URL), keys are plain names, there are at most 6 totals, 3 chart series, 6 tables and 10 columns per table, and a report needs at least one of `totals`, `chart` and `tables`.
- Days are UTC. The date range is limited to `maxDays` and the end date cannot be in the future; the date fields, the **Show** button and the quick ranges (7, 30 and 90 days, up to `maxDays`) work with the keyboard.
- The chart is an SVG with a text summary, one tooltip per bar and a legend, and every chart comes with a table of the same numbers (the first column is the row header). Colors are not the only difference between series: the legend names them and the table lists them. No chart library is loaded.
- Cells are text only; nothing from a route's answer is ever inserted as HTML.
- Missing or malformed parts of an answer show as zero or "Nothing in this period."; they do not break the page.

`plugins/analytics` is the example: its **Analytics** page is a report on `/summary`.
