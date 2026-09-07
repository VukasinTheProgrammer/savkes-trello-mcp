# App routes (source of truth)

Empty template — this file is project-specific and wasn't carried over from
wherever this skill was duplicated from (it named that project's own pages,
e.g. `frontend/src/router/route.js` or equivalent). Fill in this project's
own route list, one line per route, so `user-story.md` step 3 can build an
app-context string from it:

```
Read from <path to this project's router config>:
- `/some-route` — PageName (short description)
```

If this project has no meaningful route list (a backend-only repo, a CLI, a
library), leave this file empty — `user-story.md` step 3 then has nothing to
build a context string from and should skip that step, same as any other
empty reference file in this skill.
