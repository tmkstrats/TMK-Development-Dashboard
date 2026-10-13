# TMK Development Dashboard

A single portal for all current projects, businesses and ventures.

## Run locally

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

## Adding a project

Edit `data/projects.json`. Each entry:

| Field          | Notes                                                        |
| -------------- | ------------------------------------------------------------ |
| `id`           | Unique slug                                                  |
| `name`         | Display name                                                 |
| `type`         | Free text, e.g. Business, Venture, Side project; drives the filter chips |
| `status`       | `active`, `building`, `paused`, `idea`, `archived`           |
| `description`  | One or two lines                                             |
| `tags`         | Array of strings                                             |
| `links`        | `[{ "label": "Website", "url": "https://…" }]`               |
| `integrations` | Connected services, e.g. `{ "netlify": "site-id", "github": "owner/repo" }` |

## Deploy

Static site; `netlify.toml` publishes the repo root.
