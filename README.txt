AMBIENT MUSIC MIXER  (v3.1)  -  for the Insurgency: Sandstorm mod "Ambient Music"
mod.io: https://mod.io/g/insurgencysandstorm  -  mod ID 6488692  -  mutator: AmbientMusic
==============================================================================================

WHAT IT IS
  A small web page that runs on your own PC. With it you build your own combat music for the
  Ambient Music mod from a kit of 141 loops (8 layers: Drums, Perc, Bass, Pad, Orch, Lead, Guitar, FX;
  47 sounds, each with A / B / Fill patterns; 90 BPM, A minor). You set each layer's volume for
  CALM, MEDIUM and INTENSE, listen to the result in the browser (AUTO COMBAT plays the build-up the
  game will do), and copy a few lines of text into your server's Game.ini.
  The loops are already inside the mod: a mix is only text, so nobody needs to download anything new.

START IT
  Windows: double-click  "Start Mixer.bat".  Your browser opens http://localhost:8765/
           - With Python 3.8+ installed, presets are saved in mixer\data\music_mixes.json.
           - Without Python it uses a built-in Windows (PowerShell) server and saves presets in
             your browser instead. Nothing to install. (Python: https://www.python.org/downloads/)
           - Other PCs on your network:  Start Mixer.bat lan   (needs Python; no password, so use
             it only on a network you trust).
  Linux:   ./start_mixer.sh            (needs python3 3.8+)    then open http://localhost:8765/
           ./start_mixer.sh --lan      to reach it from another PC on your LAN, or keep the default
           and tunnel:  ssh -L 8765:localhost:8765 you@yourserver
  Port busy?  add  --port 8766  (Linux)  or edit PORT in Start Mixer.bat.
  Stop: close the window (or Ctrl+C).
  Use a current Chrome, Edge or Firefox. Click PLAY once (browsers need a click before audio).

BUILD A MIX
  1. Pick a preset on the left (Night Ops, Ghost Recon, John Wick, Full Build) or NEW / RANDOMIZE.
  2. Per layer: choose a sound (tags C / M / I = suits calm / medium / intense), set the three faders.
     LVL = use a different sound per level (e.g. soft bass in calm, distorted bass in intense).
     VARIATION / FILL = A/B patterns and a fill every 2 or 4 loops.
  3. Press 1 / 2 / 3 (or the CALM / MEDIUM / INTENSE buttons) to hear each level; AUTO COMBAT cycles them.
  4. Watch the LOUDNESS bars: CALM should sit near the white marker (about -28 LUFS) or it will be
     hard to hear in game. MASTER sets the overall music volume (exported as MixVolume).
  5. SAVE. Tick the presets that should play on your server (one is picked at random each map).

PUT IT ON YOUR SERVER
  1. Stop the server.
  2. Open its Game.ini:
       Windows server:  Insurgency\Saved\Config\WindowsServer\Game.ini
       Linux server:    Insurgency/Saved/Config/LinuxServer/Game.ini
  3. Click COPY under "SERVER EXPORT" in the mixer and paste the whole block at the end of Game.ini.
     If a [/AmbientMusic/Mutators/AmbientMusic.AmbientMusic_C] section already exists, replace it
     (do not have the section twice). Example:
       [/AmbientMusic/Mutators/AmbientMusic.AmbientMusic_C]
       MusicMode=Mix
       MixVolume=80
       MediumAt=3
       +Mixes="Full Build|Drums=V6:0,25,90:pat=AB:fill=4|Perc=V1:15,70,85:pat=AB:fill=4|..."
     (MediumAt / IntenseAt / CalmDownTime lines appear only if you moved the MUSIC SENSITIVITY sliders.)
  4. KEEP THE DOUBLE QUOTES around every +Mixes value. Without them the game only reads the name and
     the mix is silent. Do not edit the recipe text by hand; change it in the mixer and copy again.
  5. The server needs the mod and the mutator: subscribe the server to mod 6488692 and add
     AmbientMusic to its mutators (e.g. -mutators=AmbientMusic, or your mutator list).
  6. Start the server. Game.ini is only read at start-up: restart after every change.
     MusicMode: Mix = one of your ticked mixes per map (equal odds).
                Classic = the mod's original tracks.
                Random = one of your ticked mixes OR Classic per map, all equally likely: with N mixes
                ticked, Classic plays on about 1 map in N+1 (tick fewer mixes to hear Classic more often).

MUSIC SENSITIVITY (mod v3.1 or later)
  Under SERVER EXPORT, three sliders set WHEN the music changes. One setting for the whole server; it
  works in every MusicMode, Classic included. The page writes a key only when it differs from the default
  (RESET TO DEFAULT removes them again). Defaults:
    MediumAt=5       "Medium starts at": combat heat for MEDIUM  (0.5 - 10, step 0.5). 5 = real fighting nearby.
    IntenseAt=20     "Intense starts at": combat heat for INTENSE (1 - 30, step 0.5, must be above MediumAt).
                     20 = a sustained firefight.
    CalmDownTime=10  seconds the music stays MEDIUM before it can go back to CALM (5 - 90).
                     INTENSE stays at least 3/5 of it (6 s at the default).
  Combat heat: +1 for every shot fired within 60 m of you, +2 more if it passes within 8 m of you,
  +4 every half second while you are suppressed, at least 6 when you are hit. It halves every 5 seconds.
  The music steps back down when the heat falls below 3/5 of IntenseAt (INTENSE -> MEDIUM, 12 by default)
  and below half of MediumAt (MEDIUM -> CALM, 2.5 by default), once the time above has passed.
  Lower = the music reacts to less shooting; higher = only big fights change it. Getting hit on its own
  sets the heat to 6: with the defaults that gives MEDIUM, not INTENSE.
  Want the old, jumpier v3.0 behaviour? Set MediumAt=2, IntenseAt=5, CalmDownTime=20.
  Bad values in Game.ini: a value out of range falls back to its default; IntenseAt not above MediumAt
  makes both fall back to 5 and 20. Older mod versions (v3.0) ignore these keys.

EFFECTS (FX button on each layer)
  Low-pass (per intensity), high-pass, pan, reverb, delay (1/4 or dotted 1/8) and drive all play in game.
  In game each layer runs Drive -> Delay -> Reverb, then its filters, like the page. The reverb tail level
  and the drive's gain have not been fine-tuned by ear against the game yet, so they may differ a little.
  The low-pass/high-pass sliders use Wwise's own 0-100 units (the page shows the Hz).

FILES
  Start Mixer.bat / start_mixer.sh    launchers
  mixer\index.html, css\, js\         the page
  mixer\stems\                        the 141 loops (Ogg Vorbis previews of the loops inside the mod)
  mixer\data\kit_report.json, kit.json, kit_spectra.json   kit description / loudness data
  mixer\data\default_mixes.json       the 4 starter presets (browser mode)
  mixer\data\music_mixes.json         YOUR presets (created on first start, Python mode)
  mixer\mixer_server.py, serve.ps1    the two local web servers
  LICENSE.txt                         terms and credits
