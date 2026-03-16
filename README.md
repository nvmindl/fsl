# FaselHD Stremio Addon

Stream movies and TV shows from FaselHD — Arabic content with subtitles.

## Features

- Stream-only addon (no catalog) — works with IMDB IDs
- Automatic domain rotation handling
- In-memory caching for fast repeat lookups
- Supports movies and TV series (with season/episode navigation)

## Installation

```bash
npm install
npm start
```

The addon will start on port `27828` by default (set `PORT` env var to change).

### Add to Stremio / Nuvio

Once the server is running, add the manifest URL:

```
http://<your-server-ip>:27828/manifest.json
```

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `PORT` | Server port | `27828` |
| `FASELHDX_DOMAIN` | Override FaselHD domain | Auto-discovered |

## Deploy

You can deploy this addon to any Node.js hosting service (Railway, Render, VPS, etc.):

1. Set the `PORT` environment variable if required by your host
2. Run `npm start`

## License

MIT
