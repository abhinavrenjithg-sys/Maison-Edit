# Maison Edit — Build Your Look

A virtual try-on shop: pick tops, skirts, shoes and bags and see them on a model, save outfits, and buy the whole look in one tap. One codebase runs as a **website**, an **installable web app**, and an **Android app**.

```
web/                 the website (also packed into the Android app)
  index.html         the whole app: try-on canvas, shop, bag, checkout, outfits, profile
  identity.js        AI try-on likeness check and face restore (runs in the browser)
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
- **3D avatar ("You" view)**: a sculpted figure built in the browser from your height, size, skin tone and hair, with your face from the photo, wearing fitted 3D versions of the selected pieces (knit, denim, tweed, leather textures), studio lighting and soft shadows; drag to turn it 360°. Uses three.js, no AI service, nothing uploaded
- Saved pieces, bag, outfits, orders and the current look are kept on the device between visits
- Phone layout with a fixed top bar and bottom tab bar; Android back button closes open panels first

## AI try-on ("See it on me")

Upload a full-body photo and AI creates a realistic photo of you wearing the selected look. Copy `.env.example` to `.env` and pick a provider:

- **Free (default, `AI_PROVIDER=free`)**: [OOTDiffusion](https://huggingface.co/spaces/levihsu/OOTDiffusion) on Hugging Face changes the **top and skirt** (shoes and bags stay as in the photo). Without an account the daily GPU allowance is about one minute, so create a free account and a *Read* token at https://huggingface.co/settings/tokens and put it in `HF_TOKEN`. Takes 1–3 minutes per look.
- **Gemini (`AI_PROVIDER=gemini`)**: changes the whole outfit and is faster, but image generation needs billing on the key in Google AI Studio. Put the key in `GEMINI_API_KEY`.

Run `node serve.mjs`. Keys stay on the server; they are never sent to the browser, and `.env` is not committed.

In the Android app, open *Profile → See the outfit on my photo* and enter the server address shown on the computer running `serve.mjs` (for example `http://192.168.1.5:5173`, same Wi-Fi).

### Identity preservation (it must be *you*, not a model)

Every try-on, from either provider, goes through a check-and-restore pipeline in `web/identity.js`. It runs in the browser; the only things sent to Gemini are the photos it already needed, plus a close-up of the face.

1. **Photo check, before generating.** The uploaded photo must contain exactly one person with a readable face. Otherwise *Generate* stays off. A small face, a turned head or a cropped body gives a warning.
2. **Strict prompt (Gemini).** The server asks Gemini to edit, not reimagine. It must keep the face, hair, skin tone, body shape, pose, framing and background, and copy every product detail. It sends a high-res close-up of the face as a second identity reference and asks for the same aspect ratio as the photo.
3. **Likeness check on the result:**
   - **Face:** distance between face-recognition descriptors (dlib ResNet via face-api). On labelled test photos the same person was always ≤ 0.48 and different people were always ≥ 0.65.
   - **Skin tone and hair:** CIE ΔE colour comparison of the cheeks, forehead, and the hair above the forehead and at the temples.
   - **Body:** shoulder, hip, leg and neck proportions from MoveNet keypoints, plus pose similarity.
   - **Clothing:** product colour against the colour worn in the result, for the pieces the AI actually changed. This one is advisory.
4. **Face restore.** If the AI drifted the face, the person's real face is put back from their photo. It is aligned to the result with a similarity transform over the face mesh (rotation, scale and position only, so the face shape is never warped), blended with a feathered mask, and matched to the scene's brightness while keeping the original skin colour. The result is then checked again.
5. **No silent acceptance.** If the AI drew a different person, the result is rejected rather than patched. A far-off face counts as a different person when it is beyond 0.66, or beyond 0.55 when the hair, body and pose aren't clearly the user's own. A rejected result is also blurred; *Regenerate* is the main action, and *Save image* is hidden. Every result shows its report. A restored result is labelled, and you can compare it with the AI's original. If the checker can't load, the result is marked *Not verified* with a button to run the check again.

The models (Human 3.3.6 and face-api 1.7.15, about 16 MB) load from jsDelivr the first time and are then cached by the service worker. Thresholds live in `LIMITS` at the top of `identity.js`.

Known limits: hair is compared by colour, not shape. Body shape is measured from skeleton proportions, not the silhouette, so it can't see a narrowed waist on its own. The face restore needs the head at roughly the same angle as in the photo, and otherwise asks you to regenerate.

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
