# LocalBridge Studio

A local dashboard for hosting multiple local projects on your LAN and exposing them with public tunnel URLs.

## Run

```bash
npm install
npm start
```

Open:

```txt
http://localhost:3000
```

## What it does

- Tool dashboard runs on `localhost:3000`.
- Each project can run on its own local port.
- Same Wi-Fi devices use the LAN URL, such as `http://192.168.1.37:4100`.
- Remote devices on another network use the Public URL, such as `https://example.loca.lt`.
- Full-stack projects can use one internal proxy URL so frontend and backend share one public tunnel.

## Modes

- Static project
- Frontend only
- Backend/API only
- Full stack frontend + backend
- Auto detect

## Tunnel providers

- LocalTunnel: no login required, uses `npx --yes localtunnel`.
- Ngrok: requires installed ngrok and auth token.
- Cloudflared: requires installed cloudflared.

## Important

Share only your own authorized local projects.
<img width="1917" height="966" alt="image" src="https://github.com/user-attachments/assets/c5053eab-c7a6-4ea3-bd85-2c06de133040" />

