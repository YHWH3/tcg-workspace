# Apple Simulator Safari acceptance

Run from the `feature/unified-ai-mcp` checkout on a Mac with Xcode selected:

```sh
xcode-select -p
xcodebuild -version
xcrun simctl list runtimes
xcrun simctl list devices available
node scripts/apple-safari.mjs
```

This generates a temporary **UI-test bundle**, launches `com.apple.mobilesafari`, and tests the existing web application. It does not add a native product or change the browser-first architecture. The runner owns a disposable built Worker/D1 fixture, uses a random loopback port, synthetic records, and the simulated provider. No production resources, external connectors or real models are used. Permissions are disabled for platform-parity tests; the permission-enabled D1/OAuth suites remain separate security evidence.

The default matrix uses these devices **only when installed**: a disposable iPhone SE (3rd generation) named `TCG compact SE3 acceptance`, iPhone 17, iPhone 17 Pro Max, iPad (A16), and iPad Pro 13-inch (M5). The SE3 device type was confirmed in the installed runtime's supported-device list; create it with `xcrun simctl create "TCG compact SE3 acceptance" com.apple.CoreSimulator.SimDeviceType.iPhone-SE-3rd-generation com.apple.CoreSimulator.SimRuntime.iOS-26-4` when absent. No runtime download is performed. Use explicit installed UDIDs to select another runtime or device:

```sh
APPLE_ARTIFACT_DIR=.artifacts/pr13-apple/run-name node scripts/apple-safari.mjs --skip-build --devices=UDID,UDID
```

For a focused diagnostic, `--only-test=test04CanvasAlternatives` (or another named test in `SafariTests.swift`) runs only that journey and its corresponding server persistence check. The result records the reduced scope and cannot be cited as the complete matrix.

`--skip-build` requires a current build from the exact source being tested. Without it the runner builds first. It preserves previously booted devices and shuts down only devices it booted. It never erases simulator data. A new fixture origin ensures existing accounts are not used.

iPhone tests use the real sign-in form. iPad tests use a **preauthenticated synthetic fixture session** installed by temporary local asset files, because this Xcode/runtime combination waits 60 seconds at each Safari secure-field animation boundary. The fixture entry files contain only disposable session material, are never put in URLs/logs/source, and are removed during teardown. Interactive iPad sign-in remains NOT RUN by this harness.

Each device gets an `xcresult` bundle, Xcode exit code, logs and exported screenshot attachments. `toolchain.json` records source SHA, tree, fingerprint, dirty/clean state, installed runtimes and devices. `results.json` is updated after every device. An unavailable explicit device, failed test, timeout or changed source makes the process fail. Simulator failures are preserved and must be investigated rather than silently classified as application defects.

The UI tests cover browser sign-in; Unicode rich-text input; software keyboard; rotation while editing; Safari background/foreground draft recovery; compact assistant/drawer controls; sourced simulated response; human approval and execution; search; record-detail navigation and description editing; canvas zoom controls, item-list nudge, and rendered geometry changes after pinch/pan gestures. Each device uses unique edit/proposal markers, resets the synthetic source values, and checks page text, record description, canvas position and exactly one proposed page against server records. Prior devices cannot satisfy these checks. Screenshots document actual Safari toolbar and keyboard geometry. This is a focused parity journey, not exhaustive certification of every canvas/media gesture.

The keyboard's native **Next** and **Done** controls are used during sign-in. They are normal touch controls, not application backdoors. The R13-04 regression in `verify-release-ui.mjs` additionally checks compact shared input text is at least 16 CSS pixels to avoid Safari's automatic focus zoom. Browser zoom remains enabled.

## External checks that this runner does not replace

- The immediately preceding supported OS family needs its own installed runtime and execution.
- Physical iPhone/iPad and Android; physical camera/microphone and file providers.
- Human VoiceOver/TalkBack/NVDA, native 400% zoom and text scaling.
- Real HTTPS/staging deployment and real third-party MCP hosts.
- Installed Home Screen/PWA mode, storage eviction, OS background suspension and offline network transitions.
- Split View/Stage Manager resizing and canvas multitouch precision on actual hardware.

For each external pass, record device/OS/browser build, route, actions, expected result, screenshot or screen recording, tester/date and defects. Do not replace these entries with desktop WebKit results.
