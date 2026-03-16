<p align="center">
  <a href="https://selene.run">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="Selene logo">
    </picture>
  </a>
</p>
<p align="center">AI-kodeagent med åpen kildekode.</p>
<p align="center">
  <a href="https://selene.run/discord"><img alt="Discord" src="https://img.shields.io/discord/1391832426048651334?style=flat-square&label=discord" /></a>
  <a href="https://www.npmjs.com/package/selene-ai"><img alt="npm" src="https://img.shields.io/npm/v/selene-ai?style=flat-square" /></a>
  <a href="https://github.com/anomalyco/selene/actions/workflows/publish.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/anomalyco/selene/publish.yml?style=flat-square&branch=dev" /></a>
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a> |
  <a href="README.zht.md">繁體中文</a> |
  <a href="README.ko.md">한국어</a> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.es.md">Español</a> |
  <a href="README.fr.md">Français</a> |
  <a href="README.it.md">Italiano</a> |
  <a href="README.da.md">Dansk</a> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.pl.md">Polski</a> |
  <a href="README.ru.md">Русский</a> |
  <a href="README.ar.md">العربية</a> |
  <a href="README.no.md">Norsk</a> |
  <a href="README.br.md">Português (Brasil)</a> |
  <a href="README.th.md">ไทย</a> |
  <a href="README.tr.md">Türkçe</a> |
  <a href="README.uk.md">Українська</a> |
  <a href="README.bn.md">বাংলা</a> |
  <a href="README.gr.md">Ελληνικά</a>
</p>

[![Selene Terminal UI](packages/web/src/assets/lander/screenshot.png)](https://selene.run)

---

### Installasjon

```bash
# YOLO
curl -fsSL https://selene.run/install | bash

# Pakkehåndterere
npm i -g selene-ai@latest        # eller bun/pnpm/yarn
scoop install selene             # Windows
choco install selene             # Windows
brew install anomalyco/tap/selene # macOS og Linux (anbefalt, alltid oppdatert)
brew install selene              # macOS og Linux (offisiell brew-formel, oppdateres sjeldnere)
sudo pacman -S selene            # Arch Linux (Stable)
paru -S selene-bin               # Arch Linux (Latest from AUR)
mise use -g selene               # alle OS
nix run nixpkgs#selene           # eller github:anomalyco/selene for nyeste dev-branch
```

> [!TIP]
> Fjern versjoner eldre enn 0.1.x før du installerer.

### Desktop-app (BETA)

Selene er også tilgjengelig som en desktop-app. Last ned direkte fra [releases-siden](https://github.com/anomalyco/selene/releases) eller [selene.run/download](https://selene.run/download).

| Plattform             | Nedlasting                            |
| --------------------- | ------------------------------------- |
| macOS (Apple Silicon) | `selene-desktop-darwin-aarch64.dmg` |
| macOS (Intel)         | `selene-desktop-darwin-x64.dmg`     |
| Windows               | `selene-desktop-windows-x64.exe`    |
| Linux                 | `.deb`, `.rpm` eller AppImage         |

```bash
# macOS (Homebrew)
brew install --cask selene-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/selene-desktop
```

#### Installasjonsmappe

Installasjonsskriptet bruker følgende prioritet for installasjonsstien:

1. `$SELENE_INSTALL_DIR` - Egendefinert installasjonsmappe
2. `$XDG_BIN_DIR` - Sti som følger XDG Base Directory Specification
3. `$HOME/bin` - Standard brukerbinar-mappe (hvis den finnes eller kan opprettes)
4. `$HOME/.selene/bin` - Standard fallback

```bash
# Eksempler
SELENE_INSTALL_DIR=/usr/local/bin curl -fsSL https://selene.run/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://selene.run/install | bash
```

### Agents

Selene har to innebygde agents du kan bytte mellom med `Tab`-tasten.

- **build** - Standard, agent med full tilgang for utviklingsarbeid
- **plan** - Skrivebeskyttet agent for analyse og kodeutforsking
  - Nekter filendringer som standard
  - Spør om tillatelse før bash-kommandoer
  - Ideell for å utforske ukjente kodebaser eller planlegge endringer

Det finnes også en **general**-subagent for komplekse søk og flertrinnsoppgaver.
Den brukes internt og kan kalles via `@general` i meldinger.

Les mer om [agents](https://selene.run/docs/agents).

### Dokumentasjon

For mer info om hvordan du konfigurerer Selene, [**se dokumentasjonen**](https://selene.run/docs).

### Bidra

Hvis du vil bidra til Selene, les [contributing docs](./CONTRIBUTING.md) før du sender en pull request.

### Bygge på Selene

Hvis du jobber med et prosjekt som er relatert til Selene og bruker "selene" som en del av navnet; for eksempel "selene-dashboard" eller "selene-mobile", legg inn en merknad i README som presiserer at det ikke er bygget av Selene-teamet og ikke er tilknyttet oss på noen måte.

### FAQ

#### Hvordan er dette forskjellig fra Claude Code?

Det er veldig likt Claude Code når det gjelder funksjonalitet. Her er de viktigste forskjellene:

- 100% open source
- Ikke knyttet til en bestemt leverandør. Selv om vi anbefaler modellene vi tilbyr gjennom [Selene Zen](https://selene.run/zen); kan Selene brukes med Claude, OpenAI, Google eller til og med lokale modeller. Etter hvert som modellene utvikler seg vil gapene lukkes og prisene gå ned, så det er viktig å være provider-agnostic.
- LSP-støtte rett ut av boksen
- Fokus på TUI. Selene er bygget av neovim-brukere og skaperne av [terminal.shop](https://terminal.shop); vi kommer til å presse grensene for hva som er mulig i terminalen.
- Klient/server-arkitektur. Dette kan for eksempel la Selene kjøre på maskinen din, mens du styrer den eksternt fra en mobilapp. Det betyr at TUI-frontend'en bare er en av de mulige klientene.

---

**Bli med i fellesskapet** [Discord](https://discord.gg/selene) | [X.com](https://x.com/selene)
