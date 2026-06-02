Drop your own video files here (mp4, webm, mov, mkv, avi…).
This folder is intentionally not pre-populated — we don't have a tiny
synthesizable video generator in pure Node, and shipping a real video
would bloat the repo. The VideoView in apps/desktop handles HTTP Range
seeking so even multi-GB files play instantly.
