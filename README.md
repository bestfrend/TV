# Lietuviška TV

Atskira TV Apps PWA. Ji turi savo serverį, prisijungimą ir TV API. `winAlpa` paleisti nereikia.

## Paleidimas iš Visual Studio Code

```powershell
cd "C:\Users\tautv\Desktop\TV App's"
npm start
```

Kūrimo metu galima naudoti `npm run dev`. Programa veikia per `http://localhost:4174`.

## Prisijungimo slaptažodis

Faile `.env` nustatykite:

```env
TV_APP_PASSWORD=JusuSlaptazodis
```

Šis prisijungimas yra nepriklausomas nuo `winAlpa` vartotojų ir Electron būsenos.

## Tailscale telefonui

Kai TV Apps serveris jau paleistas, administratoriaus PowerShell lange:

```powershell
tailscale serve --bg --yes --https=8443 http://127.0.0.1:4174
tailscale serve status
```

Telefone atidarykite parodytą `https://...ts.net:8443` nuorodą. Abu įrenginiai turi būti prisijungę prie tos pačios Tailscale paskyros.

Jei norite grąžinti `winAlpa` Tailscale maršrutą:

```powershell
tailscale serve --https=8443 off
```

## Electron TV Apps

TV Apps Electron dalis yra atskira maža programa šiame projekte. Ji naudoja tą patį TV web ekraną ir LRT API, bet neturi `winAlpa` rendererio, logotipo, voice ar remote-control dalių.

Kūrimo metu paleiskite:

```powershell
npm install
npm run electron
```

Windows paketą sukurkite:

```powershell
npm run desktop:dist
```
