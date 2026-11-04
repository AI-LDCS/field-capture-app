# Admin guide

For the person who sets up workers and routes, hands out work and reviews results. Everything is in the web app; sign in at your server's address.

- [First sign-in](#first-sign-in)
- [Workers](#workers)
- [Routes](#routes)
- [The route editor](#the-route-editor)
- [Assigning work](#assigning-work)
- [Reviewing](#reviewing)
- [Downloads](#downloads)

The sun, moon and monitor icons at the top choose a Light, Dark or System theme. This browser remembers the choice.

## First sign-in

Use the admin username and password from the server's `.env` file (`ADMIN_USERNAME`, `ADMIN_PASSWORD`). **Change the password straight away**: click your username at the top right. It needs at least 12 characters; changing it signs out your other devices.

The top bar has **Assignments**, **Routes**, **Workers** and **Downloads**.

## Workers

**Workers → Add a field worker.**

- Enter a **username** (3 to 32 letters, digits, `.` `_` `-`; the app makes it lowercase) and optionally a display name.
- Type a **password** (8 or more characters) **or leave it empty** and the app generates one and shows it **once**. Copy it and give it to the worker. The app stores only a hash, so it cannot show it again.
- A worker cannot change their password. It never expires.

For each worker you can **Set password** (type a new one, or leave empty to generate one; the worker is signed out everywhere at once). The **⋯** menu beside it has **Rename**, **Deactivate** or **Reactivate**, and **Delete**. A deactivated worker is signed out immediately and cannot log in; their data stays.

**Delete** removes a worker for good: they are signed out, cannot log in again, and disappear from the list, and you can reuse their username. Their assignments, recordings and video are kept and show as `username (deleted)`. Deleting cannot be undone; if you might want the worker back, deactivate instead.

Share the server address with the worker. For the camera and GPS the address must be HTTPS.

## Routes

**Routes** lists each route with its versions. A version is **draft**, **published** or **archived**.

- A **draft** can be edited, published or deleted.
- A **published** version's segments can never change. You can **assign** it, **view** it, or **archive** it (no new assignments; existing ones carry on).
- To change a published route, press **+ New version**: it copies the latest version into a new draft. Existing assignments keep the version, and the segments, they were given.
- Publishing a new version archives the previous one. A route needs at least one **required** segment, and every segment must be at least 5 m long.

**Rename** (in the **⋯** menu at the top right of a route's card) changes the route's name everywhere: all its versions, existing assignments, reviews and downloads. Nothing else changes, and the old and new names are written to the audit log.

**Delete route** (same menu) removes the whole route from the list. You can no longer assign it, but its assignments, recordings and video are kept and show `(deleted)`, and workers can finish assignments they already have. A route that was never published is removed completely. Deleting cannot be undone; to only stop new assignments, archive the version instead.

**+ New route** opens the editor.

## The route editor

A route is an ordered list of **segments**. Each segment is **required** (must be walked before the assignment can complete) or **optional** (the worker may skip it). Skipping an optional segment never skips the next one.

**Draw on the map**
1. **＋ New segment**, then click the map to add points along the path. Press **Esc** (or the Draw button) to stop.
2. Each segment is **Curved** by default: place points along the sidewalk and the line bends smoothly through them. Add a point wherever it bends. Switch a segment to **Straight** for point-to-point lines. The app does not know where sidewalks are; it only smooths what you place.

**Snap** (on by default; the **Snap** button on the map turns it off, and your browser remembers)
- Bring the end of a segment close to the start of another, or a start close to an end, and it sticks to that exact point. A green ring shows where. This works when you drag a segment's first or last point, and when you click to add points while drawing.
- Only the point you move changes. The two segments are not linked, so dragging one end away again separates them. Typed and pasted coordinates are never snapped.

**Edit points**
- **Drag** a point on the map. Click a **+** on the line to add a point there. Select a point and press **Delete** to remove it.
- Below the list, a table shows the selected segment's points as **latitude and longitude**: edit the numbers, press **+** to add a point after one, **✂** to split the segment there, **✕** to delete. Type `lat, lng` and press Add to append a point.
- **Paste many points**: one `lat, lng` per line in route order; a blank line starts a new segment; put `optional` on its own line before a segment to make it optional.

**Order and settings** (click a segment in the list)
- **Drag the ⋮⋮ grip** to change the walking order (the arrows also work). The numbers, colours and direction arrows on the map follow the order.
- Name, **Required / Optional**, **Must cover (%)** (how much of the segment the worker's track must cover; default 90), **Reverse** direction, **Join with next**, **Delete**.

**Autosave**: a draft saves itself about 2 seconds after you stop editing, and the status next to the title says **Saved**. A new route is saved as soon as it has a finished segment, named **Untitled route** until you name it; give it a real name before publishing. A segment with fewer than 2 points waits until it has 2. If the connection drops, it keeps trying, and leaving the tab warns you. Published versions never change.

**Safety**: **Ctrl/Cmd + Z** undoes, **Shift + Ctrl/Cmd + Z** redoes. **Revert** goes back to how the route was when you opened the page. **Save draft** saves now; **Save & publish** publishes.

The street / terrain / satellite switch is at the top right of every map.

## Assigning work

**Assignments** (the home page) or **Routes → Assign** on a published version. Choose the route version and an **active** worker, then **Assign**. The worker sees it in **My assignments**. You can **Withdraw** an assignment only until the worker starts it. Filter the list by status or worker.

Status words:

| Status | Meaning |
| --- | --- |
| assigned | not started |
| in progress | recordings exist; required segments not all covered yet |
| pending sync | the worker asked for the check, but the server is missing a finished upload |
| needs review | everything was covered, but something needs your eye (see below) |
| completed | all required segments covered and nothing flagged, or you approved it |

## Reviewing

Open an assignment to see the worker, status, the **reasons** behind it, the GPS-check result and GPS quality counts. The map shows the segments (green = done), arrows for their walking direction, and the recorded track.

- **Needs review** happens when the GPS check was skipped, many GPS points were poor or off route, there were several gaps, or the recording was made with test (simulated) data. **Approve** completes it; **Send back** returns it to in progress so the worker can record more. **Re-evaluate** recomputes from the stored data.
- **Segments** table: each segment's status and coverage, and where it was seen. Press **▶** to jump the video to the moment that recording was on that segment.
- **Recordings**: each recording with its size and GPS count. When the video is ready, play it: the **red dot on the map follows the video**. A recording that is still being prepared says so; if the build failed there is a **Retry** button.
- **Audit**: who did what, and when, for this assignment and its recordings.

Coverage and completion are decided by the server from verified recordings only; the phone cannot mark anything complete.

## Downloads

The **Downloads** tab lists every verified recording, newest first: route and version, worker, start time, length, file size and GPS count. Filter by worker. Each row has **Video**, **GPS (.json)** and **All (.zip)** (the whole assignment: every video, the GPS files and `assignment.json`); click the route name to open the assignment. A video that is still being built shows "preparing video…" until it is ready. Recordings that were never fully uploaded and verified are not listed.

The same downloads are also on a reviewed assignment: **Download all (.zip)** (videos, one GPS JSON per recording, and `assignment.json`), **Data (.json)**, and per recording **Video** and **GPS (.json)**. GPS files include `videoTimeS` so points line up with the footage. Every view and download is recorded in the audit trail. Workers cannot download anything.
