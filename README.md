# Scribble Siege

A 1v1 online game where each player paints an army and some terrain onto their half of the map, within a budget. Then the battle plays out live for both players.

It's a static site with no game server. The host's browser runs the room and the battle, and your friend connects to it directly over WebRTC.

## Play

Open the site, enter a name and click **Create a room**. Click **Copy invite link** and send it to your friend. When they open it and click **Join**, you're both in the lobby.

The host's tab is the game server, so keep it open while you play. If the host reloads, the room reopens with the same code and the friend reconnects automatically, but the match goes back to the lobby.

## Host it on GitHub Pages

1. Push this folder to a GitHub repository.
2. In the repository, open **Settings → Pages**. Under **Build and deployment**, choose **Deploy from a branch**, then pick **main** and **/ (root)**.
3. After a minute the game is live at `https://<your-username>.github.io/<repo-name>/`.

Any static host works the same way (Netlify, Cloudflare Pages, itch.io and so on). Everything uses relative paths, so it also works from a subfolder.

## Run it locally

```powershell
npm start
```

Then open http://localhost:3000. This is only a static file server, needed because ES modules and Web Workers don't load from `file://`. To try it alone, open a second tab and join your own room. Seats are per tab. Two tabs in one browser share the saved player name, so set it before each create or join.

`npm test` plays a headless two-player match against the room logic and checks the static server.

## How a match works

1. **Lobby.** The host sets:
   - the **budget** per player
   - every **unit cost** and **terrain cost per tile**
   - whether the opponent's drawing is **hidden until battle** or **visible live**
   - an optional **draw time limit**

   The host's browser remembers these rules for the next room.
2. **Draw.** Paint on your side of the map. The hatched middle strip is no-man's-land.
   - Pick a unit or terrain type, then drag.
   - The brush size controls how big an area you fill. Small brushes place single units.
   - Right-drag or **E** erases. **Ctrl+Z** undoes. **[** and **]** change the brush size. **1–9** pick from the palette.
   - Painting stops when you run out of budget.
3. **Battle.** Once both players click Ready, or the timer runs out, there's a 3-second countdown and then the fight. The battle ends when an army is wiped out, or after 3 minutes. At the time limit, whoever kept the bigger share of their army's value wins.
4. **Results.** The host can start a rematch, which keeps both armies so you can adjust them, or go back to the lobby to change the rules.

### Units

| Unit | Default cost | Notes |
|---|---|---|
| Militia | 1 | Cheap melee fodder |
| Pikeman | 2 | Long reach, triple damage against Lancers and Golems |
| Archer | 3 | Ranged, backs away from melee. Walls block arrows |
| Hound | 2 | Very fast biter |
| Lancer | 5 | Charge damage and knockback that grow with speed |
| Medic | 4 | Heals wounded allies |
| Bombardier | 6 | Lobs splash-damage bombs over walls |
| Golem | 18 | Huge HP, area smash that throws units |

### Terrain (cost per 10×10 tile)

| Terrain | Default cost | Effect |
|---|---|---|
| Stone Wall | 0.25 | Blocks movement and arrows |
| Pond | 0.12 | 45% speed. Units standing in it can't shoot |
| Mud | 0.08 | 60% speed |
| Brambles | 0.15 | 80% speed, light damage over time |

## How it's built

```
index.html         The page (GitHub Pages serves it from the repo root)
client/            Canvas renderer, editor, lobby UI, networking (plain ES modules, no build step)
client/vendor/     PeerJS 1.5.4 (MIT), vendored so there's no CDN dependency
host/hub.js        The room "server": connections, joins, heartbeats
host/room.js       Lobby/draw/battle/results state machine, draft validation, reconnects
host/sim.js        Battle simulation (30 Hz): spatial hash, Dijkstra flow fields, AI
host/worker.js     Runs the hub in a Web Worker inside the host's tab
shared/            Units, terrain, costs, draft encoding, binary snapshot format
tools/serve.js     Local static server for development
test/smoke.js      Headless end-to-end test: npm test
```

- **The host's browser is the server.** The room and the battle run in a Web Worker in the host's tab. Worker timers aren't throttled in background tabs, so the battle keeps its pace if the host switches tabs. Both players' drafts are validated against the budget and their zone. The host's own player goes through the same checks as the friend. Because the host's browser runs the simulation, a host who edits the code could cheat. That's fine for games between friends.
- **Networking.** [PeerJS](https://peerjs.com/) connects the two browsers over a WebRTC data channel. The room code maps to a PeerJS ID (`scribble-siege-room-ABCD`) on PeerJS's free public broker, which is only used to make the introduction. Game data goes directly between the players. When strict NATs or firewalls block a direct connection, it goes through PeerJS's public TURN relay instead. Battles stream as binary snapshots at 15 Hz (10 bytes per unit), and the guest's client smooths them by interpolation.
- **Reconnecting.** If the guest drops, they get their seat back within 2 minutes, including mid-battle. Both sides send heartbeats every 3 seconds, and 15 seconds of silence counts as a disconnect.
- **Limits.** The match lasts only as long as the host's tab is open. A few very locked-down networks (some school or office firewalls) block WebRTC entirely.
- **Adding a unit.** Add an entry to `UNITS` in `shared/config.js` and a drawing function in `client/sprites.js`. If it needs new behaviour, add a role in `host/sim.js`.
