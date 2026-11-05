# Profile format (v1)

A profile describes one site's tools. It's a JSON file, never code. The schema lives in
[`packages/shared/src/profile.ts`](../packages/shared/src/profile.ts); `anymcp validate <file>` checks a file against it.

## Top level

| Field | Type | Notes |
|---|---|---|
| `schemaVersion` | `1` | |
| `id` | string | Usually the site's domain, e.g. `github.com`. In the registry it must equal the folder name. Lowercase letters, digits, `.` and `-`. |
| `name` | string | Shown to people and the AI. |
| `description` | string | At least 10 characters. Say what the site's tools do. |
| `version` | `"x.y.z"` | Bump it when you change the profile. |
| `authors` | string[] | GitHub usernames or names. |
| `categories` | string[] | Ids from [`registry/categories.json`](../registry/categories.json). |
| `origins` | string[] | Sites this profile belongs to, like `https://github.com` (no path). The extension suggests the profile when you visit them; subdomains match too. |
| `auth` | `"none"` or `"browser-session"` | `none`: tools run in the gateway, no browser needed. `browser-session`: tools run in your logged-in browser tab. |
| `allowedHosts` | string[] | The **only** hosts tools may call or open, e.g. `api.github.com`. Checked when the profile loads and again on every request, including after redirects. |
| `pace` | `"strict"` \| `"normal"` \| `"relaxed"`, optional | How carefully AnyMCP spaces out calls to this site. Set `"strict"` for sites that limit accounts that act automated. AnyMCP already treats big social networks as strict, and a profile can only make a site stricter, never faster. |
| `tools` | Tool[] | At least one. |

## Tools

| Field | Type | Notes |
|---|---|---|
| `name` | string | `snake_case`, 2–64 chars, unique in the profile. The tool's id is `<profile id>/<name>`. |
| `title` | string | Short label. |
| `description` | string | What it does and what it returns. **This is what the AI searches**, so be specific. |
| `input` | JSON Schema | Must be `{"type": "object", "properties": {…}, "required": […]}`. Every `required` name must be a property. |
| `mutates` | boolean | `true` if calling it changes anything: posts, sends, buys, edits, deletes. The user is asked every time. |
| `auth` | optional | Overrides the profile's `auth` for this tool. |
| `action` | object | How to run it: `http`, `form`, `page` or `webmcp`. |

## Templates

Strings in an action can contain `{name}` placeholders, filled from the tool's arguments.

- In the URL path, values are percent-encoded: `/things/{id}` with `id = "a b"` gives `/things/a%20b`. A missing argument in the path is an error.
- A query parameter, header or form field that uses a missing argument is **left out**. So `"limit": "{limit}"` only sends `limit` when the AI passes it.
- In a JSON body, a string that is exactly `"{name}"` is replaced by the raw value, keeping numbers, booleans, arrays and objects. Keys whose value uses a missing argument are left out.
- Arrays become comma-separated lists everywhere else; objects become JSON.
- The host part of a URL can't be a template.
- Arguments that aren't in `input.properties` are ignored.
- If the AI leaves out an argument whose schema has a `default`, the default is used. For example `"first": {"type": "integer", "default": 12}` sends `12` unless the AI picks another number.

### JSON values in the query or a form

Some sites send JSON inside a query parameter or form field, for example GraphQL `variables`. Write the value as `{"json": …}`. It's filled like a JSON body (so `"{id}"` keeps the argument's type) and then sent as JSON text:

```json
"query": { "variables": { "json": { "screen_name": "{screen_name}", "count": "{count}" } } }
```

With `screen_name = "nasa"` and `count = 20` this sends `variables={"screen_name":"nasa","count":20}`. Keys whose argument is missing are left out.

### Values the browser fills in

`browser-session` tools can use three special placeholders anywhere in a request: headers, query parameters, form fields and JSON body values. They are filled inside the user's tab right before the request is sent, so the values never reach the gateway, the AI or the profile file.

- `{$cookie:name}`: a cookie on that site, for example a CSRF cookie (`"x-csrftoken": "{$cookie:csrftoken}"`).
- `{$meta:name}`: the `content` of `<meta name="name">` on the page, for example `csrf-token`.
- `{$live:name}`: a login or anti-forgery code the site's own page sends with its requests, such as Facebook's `fb_dtsg` and `lsd`, or an `authorization` header.

For `{$live:name}` the extension looks, in order, at:
1. The value the page itself last sent for that header or field (the extension keeps the latest values in the page's memory, on sites you've allowed).
2. Known places in the page's HTML for that name (for example Facebook's `DTSGInitialData`), and simple derived values (Facebook's `jazoest` is computed from `fb_dtsg`).
3. A hidden `<input name="name">`, a `<meta name="name">` or a cookie with that name.
4. A `"name": "value"` pair in an inline script.

If a value still isn't found, that header or field is left out, and the tool's result says which ones were missing. Usually opening the site in Chrome, signed in, and using it for a moment fixes it. These placeholders are rejected in `auth: "none"` tools, and any other `{$…}` placeholder is rejected.

## `http` action

```json
{
  "kind": "http",
  "method": "GET",
  "url": "https://hn.algolia.com/api/v1/search",
  "query": { "query": "{query}", "tags": "story", "hitsPerPage": "{limit}" },
  "headers": { "accept": "application/json" },
  "response": { "pick": "hits", "fields": ["title", "url", "points"], "maxChars": 20000 }
}
```

| Field | Notes |
|---|---|
| `method` | `GET`, `POST`, `PUT`, `PATCH` or `DELETE`. |
| `url` | Must start with `https://`. |
| `query` | Map of query parameters to templates. |
| `headers` | Map of headers to templates. Never put real tokens here; the registry rejects them. |
| `body` | `{"encoding": "json", "value": …}` or `{"encoding": "form", "value": {…}}`. `content-type` is set for you. |
| `response` | How to trim the response before the AI sees it. |

### Response shaping

- `pick`: a dot path into the JSON, like `hits`, `data.items` or `items.0`.
- `fields`: keep only these fields from the object, or from each item if it's an array. Dot paths work: `"package.name"`.
- `maxChars`: cap on the text returned (default 20,000). Longer output is cut and marked `[truncated]`.
- HTML responses are turned into plain text. Other text (XML, CSV) is returned as is.

Keep responses small: a tool that returns 5 useful fields beats one that returns 50.

## `form` action

Opens a page in a background tab, fills in a form and submits it. Always runs in the browser.

```json
{
  "kind": "form",
  "page": "https://example.com/search",
  "form": "form#search",
  "fields": { "query": "input[name=q]", "sort": "select[name=sort]" },
  "submit": "button[type=submit]",
  "result": { "waitFor": "#results", "read": "#results", "maxChars": 20000 }
}
```

| Field | Notes |
|---|---|
| `page` | Page to open. Must be on an `allowedHosts` host. Templates allowed in the path. |
| `form` | CSS selector of the form. |
| `fields` | Map of **argument name** → CSS selector (inside the form) of the field it fills. Each argument must be in `input.properties`. Checkboxes take `true`/`false`; selects take an option value or its visible text. |
| `submit` | Optional selector of the button to click. Otherwise the form is submitted directly. |
| `result.waitFor` | Optional selector to wait for after submitting. |
| `result.read` | Optional selector whose text is returned. Defaults to the whole page. |

### Example: a logged-in site

A profile for a site you're signed in to sets `"auth": "browser-session"`. Its `http` tools run from inside your tab with your cookies, and can pass a CSRF token without exposing it:

```json
{
  "schemaVersion": 1,
  "id": "example.com",
  "name": "Example Notes",
  "description": "Read and create notes in your Example account.",
  "version": "0.1.0",
  "authors": ["you"],
  "categories": ["productivity"],
  "origins": ["https://example.com"],
  "auth": "browser-session",
  "allowedHosts": ["example.com"],
  "tools": [
    {
      "name": "create_note",
      "title": "Create note",
      "description": "Create a note in your Example account. Returns the new note's id and URL.",
      "input": {
        "type": "object",
        "properties": { "title": { "type": "string" }, "body": { "type": "string" } },
        "required": ["title"]
      },
      "mutates": true,
      "action": {
        "kind": "http",
        "method": "POST",
        "url": "https://example.com/api/notes",
        "headers": { "x-csrf-token": "{$meta:csrf-token}" },
        "body": { "encoding": "json", "value": { "title": "{title}", "body": "{body}" } },
        "response": { "fields": ["id", "url"] }
      }
    }
  ]
}
```

If no tab for the site is open, the extension opens one in the background.

## `page` action

For sites without a usable API. Opens a URL in a background tab, signed in as the user, waits for the page to render and returns its main text. The tab is closed afterwards. Always runs in the browser, whatever the profile's `auth` says.

```json
{
  "kind": "page",
  "url": "https://news.example.com/articles/{slug}",
  "query": { "lang": "{lang}" },
  "waitFor": "article h1",
  "read": "article",
  "maxChars": 20000
}
```

| Field | Notes |
|---|---|
| `url` | URL template, `https://` only. Path values are percent-encoded. |
| `query` | Optional query parameters (templates or `{"json": …}`); left out when their argument is missing. |
| `waitFor` | Optional CSS selector to wait for before reading (for pages that load content with JavaScript). |
| `read` | Optional CSS selector whose text is returned. Defaults to the page's main content (`main`, `article`, or the body). |
| `maxChars` | Cap on the returned text. Default 20000. |

Recording turns the pages you visit into `page` tools: `/jane.doe.art/` and `/natgeo/` become one `open_page` tool with a `name` parameter.

## `webmcp` action (experimental)

Some sites declare their own tools to AI agents through WebMCP (`navigator.modelContext`). The extension can find them, and a profile can point at one:

```json
{ "kind": "webmcp", "page": "https://example.com/app", "tool": "add_to_cart" }
```

The arguments are passed to the site's tool as they are. WebMCP is still a draft standard, so this may change.

## Example: Facebook-style persisted GraphQL

Facebook, Instagram and Threads send every request to one URL (`/api/graphql/` or `/graphql/query`). A `doc_id` picks the saved query and `fb_api_req_friendly_name` names it. This is roughly what recording produces for such a site (made-up site and ids):

```json
{
  "schemaVersion": 1,
  "id": "social.example",
  "name": "Social Example",
  "description": "Profile pages on Social Example, read as you.",
  "version": "0.1.0",
  "authors": ["you"],
  "categories": ["social"],
  "origins": ["https://www.social.example"],
  "auth": "browser-session",
  "allowedHosts": ["www.social.example"],
  "tools": [
    {
      "name": "profile_page",
      "title": "Profile page",
      "description": "Gets a user's profile (name, bio, follower count, recent posts) by user id.",
      "input": {
        "type": "object",
        "properties": {
          "id": { "type": "string", "description": "Numeric user id" },
          "render_surface": { "type": "string", "default": "PROFILE" }
        },
        "required": ["id"]
      },
      "mutates": false,
      "action": {
        "kind": "http",
        "method": "POST",
        "url": "https://www.social.example/graphql/query",
        "headers": {
          "x-csrftoken": "{$cookie:csrftoken}",
          "x-fb-lsd": "{$live:x-fb-lsd}",
          "x-ig-app-id": "{$live:x-ig-app-id}"
        },
        "body": {
          "encoding": "form",
          "value": {
            "fb_dtsg": "{$live:fb_dtsg}",
            "lsd": "{$live:lsd}",
            "jazoest": "{$live:jazoest}",
            "av": "{$live:av}",
            "__user": "{$live:__user}",
            "fb_api_caller_class": "RelayModern",
            "fb_api_req_friendly_name": "SocialProfilePageQuery",
            "doc_id": "1234567890123456",
            "server_timestamps": "true",
            "variables": { "json": { "id": "{id}", "render_surface": "{render_surface}" } }
          }
        },
        "response": { "pick": "data.user" }
      }
    }
  ]
}
```

Things to notice:
- `doc_id` and the friendly name are fixed: they're public ids of the site's saved query, not secrets.
- Everything that identifies the session (`fb_dtsg`, `lsd`, `av`, `__user`, the CSRF header) is a `{$live:…}` or `{$cookie:…}` placeholder.
- Only the real inputs (`id`) are asked of the AI; harmless constants (`PROFILE`) become defaults.
- The same pattern covers X (`/i/api/graphql/<queryId>/<Name>?variables=…`, kept in the URL) and Apollo persisted queries (`operationName` plus `extensions`).

## Categories and lists

`registry/categories.json` lists the categories. Each `registry/lists/<id>.json` is a curated bundle:

```json
{
  "schemaVersion": 1,
  "id": "travel-pack",
  "name": "Travel pack",
  "description": "Weather forecasts and place lookup for trips.",
  "authors": ["anymcp"],
  "profiles": ["open-meteo.com", "openstreetmap.org"]
}
```

Pinning a list turns all its profiles' tools into regular tools for the AI.

## `registry/index.json`

Generated by `npm run build:registry` from the folders above, and committed. It's the one file AnyMCP downloads to sync the registry. Don't edit it by hand.
