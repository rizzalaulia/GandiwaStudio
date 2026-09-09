# Web Application

React + TypeScript strict + Vite browser workspace foundation. The current shell intentionally exposes no product workflow until its dedicated issues are implemented.

## Responsibilities

- project picker and File System Access API directory handles;
- Photo/Illustration/Vector classification;
- connector/model selection without auto-routing;
- job creation and REST polling through TanStack Query;
- UI-only state through Zustand;
- candidate gallery, lightweight SVG editor, audit, metadata, approval, and export;
- checksum verification and writes to the user-owned project folder.

## Boundary

The browser has no provider-key form and never receives provider API keys. It cannot assume backend access to the local project folder. Production is a static Vite build served by host Nginx on bejo2-vnic; there is no permanent Node production server.

Implementation begins only through the gates in `docs/DEVELOPMENT-SEQUENCE.md`.