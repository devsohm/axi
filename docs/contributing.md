# Contribute to Axi

## Choose the package

Find the package that owns the behavior in the [documentation index](api.md). Read its README, specification, and relevant tests before editing. Keep runtime behavior in that package and platform details in its adapters.

Describe the observable result before changing code. Keep each change limited to that result. Extend an existing abstraction only when its callers need the change.

## Write comments that add information

Use names, types, and small functions to explain ordinary control flow. Add a comment when the reader needs information that the code cannot express clearly:

- Use a public API doc comment for ownership, lifetime, defaults, ordering, or failure behavior that the signature does not explain.
- Explain a non-obvious requirement imposed by a platform, external service, dependency, or protocol. Link its documentation or issue when available.
- Keep required legal notices and compiler directives.

Do not narrate the next statement, repeat a type, add section banners, or leave disabled code in comments. Avoid comments on every function. If a comment explains surprising behavior in our own code, first consider a clearer name or type.

Keep broader design explanations and examples in the package documentation. Update those pages when the behavior changes. Comments and documentation describe the implemented contract, including its limits.

## Verify the change

Run the focused tests for the affected behavior. For runtime or public API changes, run `npm run verify` before release. See [testing](testing.md) for prerequisites and checks outside the JavaScript suite.

For documentation changes, check local links, package import paths, and commands. Run examples that you change. Describe any examples or environments that you could not verify.

Add a test when it checks a distinct behavior or reproduces a defect. Keep expected results explicit. Extend shared backend tests instead of copying them. A passing test or a coverage percentage does not establish every possible behavior.

## Keep the documentation current

Use plain technical English and actual symbol names. Put setup and a small example in the README, exported symbols in the API reference, and behavior and limits in the specification. Link tutorials and focused guides from the [documentation index](api.md).
