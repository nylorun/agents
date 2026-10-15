---
"@nylorun/core": minor
"@nylorun/agents": minor
"@nylorun/runtime": minor
---

**HTTP tools take `GET` and `DELETE`, and URL path parameters.**

- `method` is `GET`, `POST` (default), `PUT`, `PATCH` or `DELETE`. `POST`, `PUT` and `PATCH` send the input as the JSON body, as before. `GET` and `DELETE` send no body: the input becomes the query string, after any query string written in the URL. An array repeats its name (`tag=a&tag=b`) and a `null` is left out.
- The URL's path may name input fields as `{field}`, as in `https://api.example.com/orders/{orderId}`. Each value is percent-encoded into the path and is not sent again in the body or query string. A value that is empty, `.` or `..`, or not a string, number or boolean is refused before the call is sent (`tool.invalid-input`).
- `http()` and the manifest contract check a tool against its input schema. Each `{field}` must be a required scalar property. For `GET` and `DELETE`, a property must not be an object and must not repeat a query parameter the URL already sets.
- An HTTP verifier still takes only `POST`, `PUT` or `PATCH` and a URL without `{field}` parameters, because it is sent `{ input, output, iteration }` as a body. A credential with `via` cannot serve a tool with `{field}` parameters (`http.credential`).
- core exports `httpToolRequest`, which maps a call's input to the request, and `httpPathParameters`. The Runtime's outbound `post()` is now `send()`, which can send a request without a body.
