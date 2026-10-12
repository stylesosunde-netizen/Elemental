# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.

## Data backups

Use **Export backup** at the bottom of the Quest deck to download a JSON file containing planner tasks and events, Logbook invoices and expenses, and their attachments. Keep the file somewhere safe outside the browser. **Import backup** restores those datasets and replaces the current tasks and Logbook records after confirmation; with cloud sync enabled, those replacements are synchronized to the signed-in account. It does not import notes or planner preferences.

Logbook entries retain the full invoice base, VAT, withholding, and total alongside the deductible expense base and deductible VAT. Legacy entries remain available and default to 100% deductible until edited.

## Installable offline app and cloud sync

`npm run build` generates `dist/manifest.json` and a Workbox service worker that precaches the app shell. Deploy the built directory over HTTPS (or localhost during development) for install and offline support.

Copy `.env.example` to `.env.local` and fill in the Firebase web-app configuration. The Firebase client configuration is public; access control is enforced by the rules below. Enable **Google** in Firebase Authentication, create a Firestore database, and enable Firebase Storage. Add the deployed site origin to the authorized domains in Firebase Authentication.

Deploy the included [firestore.rules](./firestore.rules) and [storage.rules](./storage.rules) to the same Firebase project before enabling sign-in. With the Firebase CLI configured for this project, run `firebase deploy --only firestore:rules,storage`. The rules restrict planner documents and Logbook attachments to their authenticated owner's UID. Storage rules further restrict attachments to PDF/JPEG/PNG files up to 2 MiB.

Sign in with Google from the planner header to enable per-account sync. Existing browser data is merged on sign-in: cloud records replace local records with matching IDs, local-only records are added, and cloud deletion tombstones keep deleted records from returning. Tasks, ideas, XP/history, and Logbook entries sync through Firestore; invoice/expense attachments use Firebase Storage. Firestore uses IndexedDB persistence, and the app continues to load from browser-local data when offline or signed out. Changes made offline are queued for sync when connectivity returns.

Cloud sync must be configured and the Firebase rules deployed before it can work. Verify the Google provider and the deployed site domain in Firebase Console when authentication is rejected.
