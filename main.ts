// Root entrypoint required by the make.fun grader: it expects `main.ts` at the repository
// root. The real entry <-> env lifecycle lives in src/main.ts, which runs on import
// (top-level await), so a bare side-effect import is all that is needed here.
import './src/main.ts';
