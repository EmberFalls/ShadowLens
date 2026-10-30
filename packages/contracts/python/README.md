# Generated Python contract types

The `shadowshield_contracts` package contains generated `TypedDict` declarations for the v2 JSON Schemas. The JSON Schemas remain the runtime validation authority; `TypedDict` annotations do not validate untrusted JSON by themselves.

Regenerate both TypeScript and Python declarations from the repository root with `npm run contracts:generate`. Run `npm run contracts:check` to verify generated output, import the Python package, resolve its type hints, and round-trip the JSON fixtures.

The API workspace can import these declarations by adding `packages/contracts/python` to its Python module path and importing from `shadowshield_contracts`. No Pydantic or other Python runtime dependency is required for the type declarations.
