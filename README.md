# Maison Edit — Build Your Look

A virtual try-on shop: pick tops, skirts, shoes and bags and see them on a model, save outfits, and buy the whole look in one tap. One codebase runs as a **website**, an **installable web app**, and an **Android app**.

```
web/                 the website (also packed into the Android app)
  index.html         the whole app: try-on canvas, shop, bag, checkout, outfits, profile
  manifest.webmanifest, sw.js, icons/   make it installable and work offline
android/             Android Studio project (Kotlin WebView wrapper)
serve.mjs            small local web server, no dependencies
.github/workflows/   builds the APK on GitHub
```

## What works

- Try on 12 pieces from 4 stores, with the sweep animation, 360° drag, undo, AI stylist looks and AR preview
- **Bag**: add single pieces or the whole look, change quantities, remove, free shipping over $150
- **Checkout**: delivery details form with checks, order number, order history (demo store: no payment is taken)
- **Outfits**: save the current look, rename it, wear it again or add it all to the bag; stylist picks included
- **Profile**: size and height (used in the fit notes), orders, clear data
- **Your face**: take a selfie or upload a photo, fit it in the oval, and it is blended onto the model
- **3D avatar ("You" view)**: a figure built in the browser from your height, size, skin tone and hair, with your face from the photo, wearing 3D versions of the selected pieces; drag to turn it 360°. Uses three.js, no AI service, nothing uploaded
- Saved pieces, bag, outfits, orders and the current look are kept on the device between visits
- Phone layout with a fixed top bar and bottom tab bar; Android back button closes open panels first

## Run the website

```bash
node serve.mjs
```

Open http://localhost:5173. In Chrome you can install it from the address bar (desktop) or with "Add to Home screen" (Android).

To publish it, upload the `web` folder to any static host (GitHub Pages, Netlify, Vercel). It must be served over https for install and offline mode.

## Build the Android app

**Option A, Android Studio (recommended):** install Android Studio, choose *Open*, select the `android` folder, wait for Gradle sync, then *Run* on a phone or emulator. For a file to share: *Build → Build App Bundle(s) / APK(s) → Build APK(s)*.

**Option B, GitHub:** push this folder to a GitHub repository. The workflow in `.github/workflows/android.yml` builds the APK; download it from the run's *Artifacts* section.

The app loads `web/` from inside the APK, so the screens work without a server. Product photos are fetched from the internet the first time.

Before publishing to Google Play, replace the debug signing in `android/app/build.gradle.kts` with your own keystore.
