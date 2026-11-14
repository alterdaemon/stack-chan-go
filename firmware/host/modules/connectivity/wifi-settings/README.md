# Robot-hosted Wi-Fi Settings

The service exists only while robot Settings is open. Configure the WWW password
before accessing account or hardware-security operations. These use the same
Basic authentication, Settings header and Origin restrictions as preferences.

## Secure storage

`GET /api/security/storage` reads hardware status. `POST` accepts only:

```json
{"action":"setup","slot":5,"confirmation":"BLOCK_KEY5_HMAC_UP_PERMANENT"}
```

Send `Content-Type: application/json` and `X-Stackchan-Settings: 1` from the
authenticated same-origin Settings page. Status fields are `state`, an optional
numeric `slot`, and an optional safe `reason`. States are `ready`,
`setup-required`, `blocked`, `unsupported` and `unknown`. No key bytes are accepted
or returned. Unsupported builds return 404; auth/validation/busy failures do not
invoke native setup. Concurrent setup is rejected; successful repeats reuse the
existing key. After a lost response, GET status; never automatically retry POST.

The separate Security card follows WWW. Ordinary Save and ChatGPT sign-in do not
invoke setup. ChatGPT rechecks previously missing storage without resetting its
auth owner. BLE has no provisioning endpoint.
