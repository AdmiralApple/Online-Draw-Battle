# Scribble Siege

An online game for 2 or 3 players. Each player paints an army and some terrain onto their part of the map, within a budget. Then the battle plays out live for everyone.

With two players it's a 1v1 on a split map. When a third player joins the lobby, the match switches to a free-for-all on a three-way map.

It's a static site with no game server. The host's browser runs the room and the battle, and your friend connects to it directly over WebRTC.

## Play

Open the site, enter a name and click **Create a room**. Click **Copy invite link** and send it to your friends. When they open it and click **Join**, they appear in the lobby. Start with two players for a 1v1, or wait for a third for a free-for-all.

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

`npm test` runs the wall pathfinding and combat-system tests against the battle sim, then plays a headless two-player match against the room logic and checks the static server.

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
   The map depends on how many players are in the lobby when the host starts. Two players split the map left and right. Three players get one region each (top, bottom-left, bottom-right), with equal drawing space, and every army fights every other army.
3. **Battle.** Once everyone clicks Ready, or the timer runs out, there's a 3-second countdown and then the fight. The battle ends when only one army is left, or after 3 minutes. At the time limit, whoever kept the biggest share of their army's value wins.
4. **Results.** The host can start a rematch, which keeps both armies so you can adjust them, or go back to the lobby to change the rules.

### Units

| Unit | Default cost | Notes |
|---|---|---|
| Militia | 1 | Cheap melee fodder. Breaks and runs when outnumbered |
| Pikeman | 2 | Long reach, triple damage against Lancers and Golems |
| Archer | 3 | Ranged, backs away from melee. Walls block arrows |
| Hound | 2 | Very fast biter |
| Lancer | 5 | Charge damage and knockback that grow with speed |
| Medic | 4 | Heals wounded allies |
| Bombardier | 6 | Lobs splash-damage bombs over walls |
| Golem | 18 | Huge HP, area smash that throws units. Fireproof and fearless |

### Terrain (cost per 10×10 tile)

| Terrain | Default cost | Effect |
|---|---|---|
| Stone Wall | 0.25 | Blocks movement and arrows. Units smash through when there is no way around |
| Pond | 0.12 | 45% speed. Units standing in it can't shoot |
| Mud | 0.08 | 60% speed |
| Brambles | 0.15 | 80% speed, light damage over time. Burns: fire races through it and sets units alight, then leaves bare ground |
| Ice | 0.1 | Almost no grip. Fast units skid and fall. Blasts and fire melt it into water |

### Props (Terrain tab, cost each)

Props are placed like units but don't fight, nobody targets them, and they don't count towards an army's survival. An army with only props left has lost.

| Prop | Default cost | Notes |
|---|---|---|
| Mine | 2 | Hidden from the enemy until it's armed. Any enemy heavy enough to set it off (not Hounds) lights a 0.4 s fuse. Blasts set off nearby mines in a chain |
| Powder Keg | 3 | Explodes in a fireball when shot, burnt or caught in a blast. Hurts every side |

### Combat systems

- **Morale.** Each unit keeps weighing up its chances: the strength of enemies close by against its friends (enemies charging in count double), fear from nearby deaths on its side, how much of its group has died, and its own wounds. Hits and near misses rattle it too. When morale runs out the unit breaks and flees (drawn in pale colours). It can rally later, and a routed unit that reaches the map edge leaves the battle for good. Golems never break.
- **Reaction and targeting.** Every unit spawns slightly different (bravery, reaction time, speed). A newly spotted enemy takes a moment to react to. Units pick between nearby enemies by distance and avoid ones that are already mobbed or under fire. Hounds hunt archers, medics, bombardiers and runners. Pikemen, Lancers and Golems stick to their target.
- **Fire.** Kegs and burning units set things alight, with a chance scaled by each unit's flammability. Burning hurts, terrifies and spreads by touch. Units run to nearby water to put it out, and medics put out burning allies. Golems are fireproof.
- **Blasts and throws.** Bombs, mines and kegs share one explosion model: damage falls off with distance, walls shield units, and big hits throw units into the air. They land hard. Lancer charges and Golem smashes can throw too. Lancers bolt from blasts and fire.
- **Dodging.** Pikemen, archers, medics, bombardiers and lancers sidestep incoming bombs if they react in time, and step away from a beeping mine.

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
test/walls.js      Pathfinding tests around walls
test/systems.js    Mines, kegs, fire, ice, morale and props
test/smoke.js      Headless end-to-end test
```

- **The host's browser is the server.** The room and the battle run in a Web Worker in the host's tab. Worker timers aren't throttled in background tabs, so the battle keeps its pace if the host switches tabs. Both players' drafts are validated against the budget and their zone. The host's own player goes through the same checks as the friend. Because the host's browser runs the simulation, a host who edits the code could cheat. That's fine for games between friends.
- **Networking.** [PeerJS](https://peerjs.com/) connects each guest's browser to the host's over a WebRTC data channel. The room code maps to a PeerJS ID (`scribble-siege-room-ABCD`) on PeerJS's free public broker, which is only used to make the introduction. Game data goes directly between the players. When strict NATs or firewalls block a direct connection, it goes through PeerJS's public TURN relay instead. Battles stream as binary snapshots at 15 Hz (12 bytes per unit, including burning, fleeing and airborne state), and each client smooths them by interpolation. Mines are sent to everyone and hidden by the client, so like the host's simulation they're on trust between friends.
- **Walls and pathfinding.** Each side gets a Dijkstra flow field toward its nearest enemies. Wall tiles count as passable but very expensive (60 tiles of open ground each), so units walk a long way round to a real gap, but a fully walled-in army still gets a route out. Units on that route, or pinned against a wall (for example by a gap too narrow for them), attack the wall. Each wall tile has 160 HP, and bomb blasts crack walls too. Broken tiles turn into open ground for everyone. Units drawn overlapping a wall are moved to the nearest open spot when the battle starts. `node test/walls.js` covers these cases.
- **Reconnecting.** If a guest drops, they get their seat back within 2 minutes, including mid-battle. Both sides send heartbeats every 3 seconds, and 15 seconds of silence counts as a disconnect.
- **Limits.** The match lasts only as long as the host's tab is open. A few very locked-down networks (some school or office firewalls) block WebRTC entirely.
- **Adding a unit.** Add an entry to `UNITS` in `shared/config.js` and a drawing function in `client/sprites.js`. Its behaviour stats (intelligence, reaction time, morale, flammability, targeting and so on) are described at the top of the `UNITS` list. If it needs new behaviour, add a role in `host/sim.js`. Set `prop: true` for things that are placed but don't fight.
