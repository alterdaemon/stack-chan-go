# R8: Settings over Wi-Fi

Release impact: minor.

The integrated CoreS3 GPT-Live firmware serves the existing shared Settings form
at `http://<robot-IP>/settings/` (port 80). Opening the IP alone redirects there.
The firmware build automatically builds and embeds only the Settings entry and
its local assets. The same React form, preference keys and frontend validation
serve HTTP and Bluetooth; Bluetooth remains available without WWW authentication.

The Wi-Fi build includes a generated copy of the SDK HTTP server with corrected
header-buffer growth. Without this correction, browser headers longer than the
first buffer expansion can stall requests and produce `ERR_CONNECTION_RESET`.
The installed SDK is unchanged. Oversized header lines close only their connection.

The final WWW section sets the Wi-Fi access password. Basic Auth accepts any
username and verifies that password for the page, assets and preference API.
The password is never returned or logged; leaving its field empty preserves it.
Changing the password takes effect immediately and reloads the HTTP page to ask
for the new credentials. Other settings are saved for the next boot/session,
following their existing behavior.

Without a configured password, HTTP access is closed. Opening the robot's existing
Settings screen connects its saved Wi-Fi and allows initial password setup for
five minutes. During that window the same web form exposes only the WWW password;
other settings and stored secrets remain unavailable until authentication.
Bluetooth can also set or replace the WWW password through its existing physical
setup/write window, without Basic Auth.

The HTTP service runs only while the existing startup Settings mode is open.
Exiting Settings or booting the robot closes it; normal operation does not run the
WWW listener. The Settings menu displays its URL and the existing Wi-Fi view shows
the connected IP. No new device controls are added.

HTTP Basic Auth does not encrypt traffic. Use within the intended trusted LAN;
TLS is outside this change. MCP continues to use its existing port and Bearer token.

R8 includes a full 16 MiB flash image and a separate application update from the
same build. The application update preserves preferences on the supported layout.
