# Contributing to the Workshop Docs

## Code Snippets from the Repo

Code blocks in workshop docs must be pulled live from source files using MkDocs Snippets — never duplicated inline. This ensures docs and code can never silently diverge; a broken tag fails `mkdocs build --strict`.

### 1. Tag the source file

Add `--8<-- [start:name]` / `--8<-- [end:name]` markers using the file's native comment syntax:

=== "Bash / shell"
    ```bash
    # --8<-- [start:my-section]
    ...code...
    # --8<-- [end:my-section]
    ```

=== "TypeScript"
    ```typescript
    // --8<-- [start:my-section]
    ...code...
    // --8<-- [end:my-section]
    ```

Tag names must be unique within a file. Use short kebab-case names.

### 2. Embed in the doc

Use a `??? example` collapsible admonition with a GitHub button above the code block:

~~~markdown
??? example "View source — description"
    [:simple-github: Open in GitHub](https://github.com/energy-digital-operations/edge-digital-operations-workshop/blob/main/path/to/file){ .md-button target=_blank }

    ```typescript
    \--8<-- "path/to/file.ts:my-section"
    ```
~~~

Paths in `--8<-- "..."` are resolved relative to the **repo root** (configured via `base_path: [workshop, .]` in `mkdocs.yml`).

### 3. Rules

- **Never hardcode GitHub line-number URLs** (e.g. `#L356`) — they drift as files change.
- **Never duplicate code** from `job-scripts/`, `amplify/`, or `frontend/` inline in docs.
- `check_paths: true` means a missing snippet path is a **build error** — if you rename a tagged file, update the docs at the same time.

---

## Deployment ID Substitution

All code blocks use `ws-slot00` as the placeholder deployment ID. The static site swaps it client-side when a participant loads a URL with `?did=ws-slotXX`:

```
https://your-workshop-site/?did=ws-slot03
```

The value persists in `sessionStorage` for the rest of the session, so it only needs to appear in the first URL the facilitator shares. See [`workshop/javascripts/deployment-id.js`](https://github.com/energy-digital-operations/edge-digital-operations-workshop/blob/main/workshop/javascripts/deployment-id.js) for the implementation.

---

## Local Dev

```bash
# Install dependencies
pip install -r requirements.txt

# Serve with live reload
mkdocs serve

# Strict build (mirrors CI)
mkdocs build --strict
```

## CI

PRs that touch `workshop/`, `job-scripts/`, `amplify/custom/participant-stack.ts`, or `mkdocs.yml` trigger `.github/workflows/docs-lint.yml`, which runs:

1. `mkdocs build --strict` — fails on any broken snippet, bad internal ref, or unknown admonition
2. `lychee` link checker against the built HTML — catches dead AWS doc links
