# Source documentation

The maintainer is an experienced backend developer exploring TypeScript and game development. Assume general programming competence when writing explanations.

- Keep purpose-focused JSDoc comments on every class, constructor, method, getter, function and callback, including nested helpers and test fixtures. Describe intent rather than paraphrasing syntax.
- Explain important state mutations, validation boundaries, units, ownership, persistence and resource lifetime where relevant. Keep short predicates brief.
- Document public callable contracts as well as their implementations. Update annotations with behavior changes.
- Preserve a callable's grammar when inserting comments, particularly returned callbacks and constructor parameter properties. Documentation-only changes must not change executable syntax.
- Keep [CODE_GUIDE.md](CODE_GUIDE.md) useful as the entry point for a developer unfamiliar with this ecosystem.
- `src/content/system-index.ts` is generated. Leave its exact output to the generator; it contains no functions to annotate.
