# Hero videos — /forge-home

Founder-generated (Veo, image-to-video from the approved scene renders).
Absent files are fine: `ForgeHomeScroll.tsx` checks `scrubbable()` and falls
back to the still + CSS zoom/beam treatment, so the page is complete without
them. Drop the files here to light them up — no code change needed.

| File | Act | What it is |
|---|---|---|
| `v1-door-open.mp4` | 1 · Gate | Doors swing inward, camera enters. **Scroll-scrubbed** |
| `v2-hall.mp4` | 2 · Hall | Corridor darkens → black → columned hall lights up. **Scroll-scrubbed** |
| `v3-tower-loop.mp4` | 3 · Tower | Silent ambient loop: ivy, hair, ember light, one `>_` blink |

## Encoding

Scrubbed clips (v1, v2) must be **all-intra** or seeking stutters — every
frame has to be a keyframe:

```
ffmpeg -i in.mp4 -c:v libx264 -g 1 -pix_fmt yuv420p -crf 20 -an v1-door-open.mp4
```

The tower loop plays normally, so it keeps a normal GOP, but it is muted and
must be seamless (first frame == last frame):

```
ffmpeg -i in.mp4 -c:v libx264 -crf 22 -pix_fmt yuv420p -an v3-tower-loop.mp4
```

Target ≤2.5 MB each. Audio is stripped (`-an`): the page never plays sound.
