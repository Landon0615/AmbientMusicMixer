# Ambient Music Mixer (v3)

A small web page for building your own combat-reactive music for the Insurgency: Sandstorm mod
**Ambient Music** (mod.io ID 6488692, mutator `AmbientMusic`). Mix 141 original loops in 8 layers
(Drums, Perc, Bass, Pad, Orch, Lead, Guitar, FX), set each layer for CALM / MEDIUM / INTENSE, hear the
build-up in your browser, and paste the result into your server's `Game.ini`.
Since v3.1 it also sets the music sensitivity (`MediumAt`, `IntenseAt`, `CalmDownTime`: when the music
goes MEDIUM / INTENSE and how long it takes to calm down) for the whole server. Defaults: `MediumAt=5`,
`IntenseAt=20` (range 1-30), `CalmDownTime=10`; the old v3.0 feel is `MediumAt=2`, `IntenseAt=5`, `CalmDownTime=20`.

## Download

Get **AmbientMusicMixer-v3.zip** from the [Releases](../../releases) page. It contains everything,
including the loops. Unzip it and double-click `Start Mixer.bat` (Windows) or run `./start_mixer.sh` (Linux).

This repository holds the source code. The loops (`mixer/stems/*.ogg`) are only in the release zip.

Full instructions: [README.txt](README.txt). Terms and credits: [LICENSE.txt](LICENSE.txt)
(code: MIT; music loops: free for Sandstorm servers running the mod and for videos/streams).

Unofficial fan-made tool. Insurgency: Sandstorm is a trademark of its owners.
