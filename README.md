# CourtVisionAI

Browser-based basketball video analysis for tracking players, possessions and shot statistics from recorded footage.

CourtVisionAI combines a basketball detector, appearance-based player re-identification, camera-motion estimation and a basketball finite-state machine (FSM). Analysis runs locally in the browser, with tracked playback, player statistics and video export available after processing.

[![](https://img.shields.io/badge/Live_Demo-ff4f0a?style=for-the-badge&logo=netlify&logoColor=white&label=&labelColor=4b4b4b)](https://courtvisionaiapp.netlify.app/)
[![](https://img.shields.io/badge/TikTok-000000?style=for-the-badge&logo=tiktok&logoColor=white&label=&labelColor=4b4b4b)](https://www.tiktok.com/@pintsizeai)
[![](https://img.shields.io/badge/Instagram-E4405F?style=for-the-badge&logo=instagram&logoColor=white&label=&labelColor=4b4b4b)](https://www.instagram.com/pintsizeai/)
[![](https://img.shields.io/badge/YouTube-FF0000?style=for-the-badge&logo=youtube&logoColor=white&label=&labelColor=4b4b4b)](https://www.youtube.com/@pintsizeai-yt)
[![](https://img.shields.io/badge/Blog-1f3d18?style=for-the-badge&logo=readthedocs&logoColor=white&label=&labelColor=4b4b4b)](https://daniel-bethell.co.uk/)

<p align="center">
  <img
    src="https://file.garden/aaBBHTW1fAvKOQLR/CourtVisionAI/github-banner.png"
    alt="CourtVisionAI"
    width="100%"
  />
</p>

---

## Overview

CourtVisionAI is designed to make basketball stat tracking possible from ordinary phone-recorded video without requiring a dedicated server-side vision pipeline.

The current workflow is:

```text
Upload video
    ↓
Basketball detection
    ↓
Deep-EIoU + OSNet + stable identities
    ↓
Basketball-specific FSM
    ↓
Attempts / makes / rebounds / possession
    ↓
Saved local session
    ↓
Playback + events + export
```

The focus is currently on simple side-view basketball footage where the basket, ball and players remain visible for as much of the clip as possible.

---

## Features

### Implemented

- Browser-based ONNX basketball inference
- Player tracking with Deep-EIoU and OSNet appearance embeddings
- Persistent player identities across tracking gaps
- Ball tracking and camera-adjusted basket memory through short detection gaps
- Post-analysis competitor selection and optional merging of duplicate identities
- 1v1 finite-state machine for:
  - possession
  - shot releases
  - shot attempts
  - made shots
  - missed shots
  - unresolved shot outcomes
  - rebounds
- Player-specific statistics:
  - field goals made
  - field goals attempted
  - field-goal percentage
  - rebounds
- Adjustable analysis quality:
  - Full - no frame skipping
  - Balanced - 15 FPS target
  - Fast - 10 FPS target
- Player thumbnails selected after identity resolution
- Timestamp-synchronised session playback
- Detection overlays during playback
- Event timeline
- Past Sessions tracker
- Browser storage usage / persistent-storage support
- Exported session video with CourtVisionAI branding for social media
- Responsive desktop and mobile UI

### In progress / planned

- Shootaround mode
  - dynamic number of players
  - multiple basketballs
  - one shot FSM per basketball
  - player / ball hand-offs
  - shooting efficiency per player
- Live camera tracking
- Additional game modes beyond 1v1
- More robust multi-ball identity recovery
- Improved portrait auto-framing
- Highlight / made-shot clip generation
- More session export options
- Settings page
- Further performance optimisation across mobile browsers

---

## How to use it

### Online

Open the live site:

[![](https://img.shields.io/badge/Open_CourtVisionAI-ff4f0a?style=for-the-badge&logo=netlify&logoColor=white&label=&labelColor=4b4b4b)](https://courtvisionaiapp.netlify.app/)

Then:

1. Open **Upload**.
2. Choose a recorded basketball video.
3. Select the game mode and analysis quality.
4. Wait for the local analysis to complete.
5. Review the detected players, merge duplicate identities if needed, and confirm the two competitors.
6. View the tracked session with timestamp-synchronised statistics and events.
7. Export the analysed video if you want a shareable version.

For the best results, keep the camera stable and try to keep the players, basketball and basket visible throughout the clip.

---

## Run locally

### Requirements

- Node.js
- npm
- A modern browser

Clone the repository:

```bash
git clone YOUR_GITHUB_REPOSITORY_URL
cd CourtVisionAI
```

Install dependencies:

```bash
npm install
```

Run the development server:

```bash
npm run dev
```

---

## Project structure

```text
CourtVisionAI/
├── assets/
│   ├── icons/
├── models/
├── vendor/
├── pages/
│   ├── upload.html
│   ├── history.html
│   └── session.html
├── scripts/
│   ├── game/
│   ├── processing/
│   ├── rendering/
│   ├── session/
│   ├── storage/
│   ├── core/
│   ├── events/
│   ├── inference/
│   ├── tracking/
│   ├── ui/
│   └── export/
├── styles/
│   ├── global.css
│   ├── home.css
│   ├── upload.css
│   ├── history.css
│   └── session.css
├── index.html
├── 404.html
├── package.json
└── vite.config.ts
```

The project is intentionally kept fairly small, everything is open-source to encourage open science!

---

## How the tracking pipeline works

CourtVisionAI separates perception from game logic.

### 1. Detection

Each analysed frame is passed through the basketball ONNX detector, with separate passes for player/basket detection and higher-resolution ball detection.

### 2. Tracking

Player detections are matched using Deep-EIoU and OSNet appearance embeddings, then passed through a persistent participant-identity layer.

This helps preserve player identities when detections briefly disappear or overlap.

### 3. Recovery

Recent ball and basket positions are retained through short detection gaps and adjusted using camera movement estimated with OpenCV optical flow. Player identities can be recovered through appearance matching, with earlier event attribution updated when identities are resolved.

### 4. Game-state logic

The 1v1 FSM uses tracked geometry over time to estimate events such as:

```text
No possession
→ Player possession
→ Release
→ Shot attempt
→ Made / missed / unresolved
→ Next possession
```

The FSM is deliberately separate from the detector so basketball rules can evolve without retraining the vision model. Shots remain unresolved when there is insufficient evidence to determine the outcome.

---

## Sessions

Completed analyses are stored locally in the browser using IndexedDB.

A session contains the original video together with:

- tracked frame data
- detections
- game state
- player statistics
- events
- player thumbnails
- selected competitors and participant identities
- session metadata

This allows the playback page to recreate the analysis without running the detector again. Match statistics use the two confirmed competitors, while other participants and unresolved events remain in the saved analysis.

Because sessions are stored locally, they remain specific to the browser/device in which they were analysed.

---

## Video export

Completed sessions can be exported into shareable videos.

Current export options include:

- landscape
- portrait
- optional detection boxes
- optional simple statistics
- permanent CourtVisionAI branding

Portrait exports use saved basketball detections to move the crop toward the ball. If the ball briefly disappears, the view stays around its last known position until tracking resumes.

If you post an exported clip, feel free to tag **[@pintsizeai](https://www.tiktok.com/@pintsizeai)**.

---

## Privacy

CourtVisionAI is designed around local browser processing.

Uploaded videos are analysed on the user's device and sessions are stored in local browser storage rather than being uploaded to an application server.

---

## Built with

- TypeScript
- Vite
- ONNX Runtime Web
- Custom YOLO basketball detector
- Deep-EIoU tracking
- OSNet appearance embeddings
- OpenCV.js
- HTML Canvas
- IndexedDB
- Netlify

---

## License

This project is released under the MIT License. See [LICENSE](LICENSE) for details.

---

## Author

Built by **Daniel Bethell**.

If you use or share CourtVisionAI, tag **@pintsizeai**.
