# Upgrade Checklist (manual)

Manual checks to run before we call an OpenBoxes upgrade ready. This covers
framework, JVM, dependency, and server upgrades. The automated comparison in
this repo comes first. This list covers what it can't check yet.

## How to use

1. Copy this file into a new GitHub issue titled `Upgrade check: <from> → <to> on <server>`.
2. Tick each box as it passes. Put failures and notes inline under the item.
3. Skip items that don't apply to this upgrade, but leave a note saying why.

## Tags

- **`required`**: must pass before release. Untagged items are optional.
- **`G7`**: specific to the Grails 7 upgrade (Java 17, Spring Boot 3, Jakarta, Tomcat 10).
- **`verify`**: confirm we still use this tool. Delete the item if we don't.
- **`new`**: not on the Grails 3 sanity sheet. Review before merging.

---

## 1. Build and CI

- [ ] `required` Webpack build log has no errors
- [ ] `required` React resources are generated and bundled
- [ ] `grails run-app --stacktrace` starts cleanly
- [ ] `required` `new` GitHub Actions workflows pass on the upgrade branch
- [ ] `new` Coverage reports still generate and publish
- [ ] `verify` Bamboo build completes
- [ ] `G7` `new` WAR builds and runs on the target JDK (17), with no leftover Java 8 flags (`MaxPermSize`, CMS GC) in `JAVA_OPTS`

## 2. Tests

- [ ] `required` Unit tests pass (`./gradlew test`)
- [ ] `required` Integration tests pass (`./gradlew integrationTest`)
- [ ] `required` `new` E2E suite (`openboxes-e2e`) passes, including receiving
- [ ] `required` `new` Compatibility comparison in this repo reports PASS

## 3. Dependencies

- [ ] `required` `new` Check every Grails plugin we use has a compatible release, or a replacement
- [ ] `G7` `new` No `javax.*` imports left where `jakarta.*` is required
- [ ] `new` Check major version bumps against their changelogs

## 4. Server environment

### Web server (Nginx)
- [ ] `required` Forwards to Tomcat
- [ ] `required` SSL works

### App server (Tomcat)
- [ ] `required` Accepts forwarded requests from Nginx
- [ ] Tomcat manager login works, and so does WAR deploy
- [ ] `G7` `new` Tomcat version supports Jakarta (10.1+)

### Infrastructure as code
- [ ] `required` `G7` `new` Ansible deploys still work after the external config plugin is removed

## 5. Database (MariaDB/MySQL)

- [ ] `required` App connects (the dashboard loads)
- [ ] `required` SSL connection works
- [ ] `required` No aborted connections in the DB logs
- [ ] Run `mysqltuner.pl`
- [ ] `required` Connection pool stats (Administration) match another server
- [ ] `required` `G7` `new` HikariCP pool settings are carried over from tomcat-jdbc. Leak detection only logs. It doesn't reclaim connections like `removeAbandoned` did.
- [ ] `required` Cache stats are available (Administration → Cache)
- [ ] `required` Hibernate isolation level and commit settings match other environments (console, JMX, or VisualVM)
- [ ] `required` Liquibase runs the expected migrations, with no "column does not exist" errors
- [ ] `required` Database migration plugin (DBM) runs without errors

## 6. Configuration

- [ ] `required` External config (`openboxes-config.groovy` / yml) is loaded
- [ ] `required` Default date format is correct
- [ ] `required` Default number format is correct

## 7. Core runtime

### Auth
- [ ] `required` Users can log in
- [ ] `required` Users can reach the features their roles allow

### Rendering
- [ ] `required` React dashboard loads
- [ ] `required` GSP pages render
- [ ] `required` Stock card page renders. This is the most complex Sitemesh layout.
- [ ] `required` Top nav renders at different screen sizes
- [ ] `required` jQuery and Bootstrap versions are correct
- [ ] `required` Icons load: Remix icons from CDN, plus webpack-bundled icons
- [ ] `required` Inter font loads in React and GSP pages
- [ ] `required` PDF downloads and renders in Chrome, Safari, and Firefox
- [ ] `required` PDF has no `Font 'Courier-BoldOblique' with 'Cp1252' is not recognized` error
- [ ] `required` DOCX templates render (order, stock movement)
- [ ] `required` POI XLS(X) export works
- [ ] `required` JXLS export works
- [ ] `required` Flying Saucer HTML rendering works

### Import / export
- [ ] `required` Product CSV import works
- [ ] `required` Location XLS import works
- [ ] `required` Product CSV download works
- [ ] `required` Other data exports work

### Files
- [ ] `required` Document upload works
- [ ] `required` Product image upload works
- [ ] `required` Uploaded files written to disk aren't corrupted, and the target directory is writable
- [ ] `required` Product image renders inline
- [ ] `required` Stock movement document downloads as an attachment
- [ ] `required` Download response headers are correct, with nothing changed by Nginx

### APIs
- [ ] `required` Status API returns data
- [ ] `required` Object marshallers return the same JSON shape as before
- [ ] `required` Exchange rate client works
- [ ] `required` List and test the other outbound REST clients

### Background work
- [ ] `required` Product availability refresh (GPars async) runs without errors
- [ ] `required` Quartz jobs fire automatically (e.g. refresh transaction fact)
- [ ] `required` Quartz jobs can be triggered manually (refresh data caches)
- [ ] `required` Transaction fact and dimension tables are populated
- [ ] `required` A known slow report performs no worse than before

## 8. Email

- [ ] `required` Email test page works (Administration → Email). Test against Mailpit/Mailtrap, never real recipients.
- [ ] `required` `new` MailService (Apache Commons Email) sends the basic cases
- [ ] `required` Links in emails use the correct `grails.serverURL`

## 9. Logging and monitoring

- [ ] `required` Sentry receives errors from the server
- [ ] `required` `new` Sentry APM / performance data is arriving
- [ ] `required` Logback writes to `catalina.out` / the expected log files
- [ ] `required` `verify` NewRelic APM metrics
- [ ] `required` `verify` NewRelic log forwarding
- [ ] `required` `verify` NewRelic infrastructure metrics
- [ ] `required` `verify` NewRelic alerts reach Slack and email
- [ ] `required` UptimeRobot alerts on downtime

## 10. External services

- [ ] CrowdIn: Enable Localization Mode works
- [ ] Google Analytics receives data from this server
- [ ] `verify` Hotjar records new sessions
- [ ] `verify` Hotjar ties sessions to users

## 11. Documentation

- [ ] DbDocs loads
- [ ] Read the Docs loads
- [ ] HelpScout knowledge base loads, including other languages
- [ ] In-app HelpScout help renders, including other languages
- [ ] Swagger docs load

## 12. Backups

- [ ] `required` Database backups are running
- [ ] `required` A database backup can be restored
- [ ] `verify` VM backups (Rimu) are running. Test a restore occasionally.

## 13. Plugins, dependencies and framework behavior

Each item has a manual check and the way to automate it. `$OLD` and `$NEW` are
the baseline and candidate base URLs, for example `http://localhost:8080/openboxes`.

### 13.1 `required` `G7` `new` URL matching (`.json` suffix and trailing slash)
Spring 6 turns both off by default. Old URLs can start returning 404.
- **Find callers:** `grep -rnE "\.json['\"?/]" src/js grails-app/views grails-app/assets`
- **Manual:** for each URL, compare the status code on both images:
  `curl -s -o /dev/null -w '%{http_code}\n' -b cookies.txt "$OLD/api/products.json"`, then the same URL on `$NEW`.
  Repeat with a trailing slash, for example `/dashboard/`.
- **Auto (`playwright`):** keep the URL list in `src/tests/api/url-matching.spec.ts`, record the status codes per image, and fail on any difference.

### 13.2 `required` `new` Dependency and WAR diff
- **Manual:** on both branches, run
  `./gradlew dependencies --configuration runtimeClasspath > deps-$BRANCH.txt`, then
  `diff deps-develop.txt deps-upgrade.txt`. Review every version change.
- **WAR jars:** `unzip -Z1 build/libs/openboxes.war 'WEB-INF/lib/*' | sort > jars-$BRANCH.txt`, then diff the two lists.
  Look for duplicates, such as two versions of the same jar, or a `javax` jar next to its `jakarta` replacement.
- **Forced versions:** for each `force` line in `build.gradle`, run
  `./gradlew dependencyInsight --configuration runtimeClasspath --dependency commons-io`.
  Remove the force if the resolved version is now newer anyway.
- **Auto (`ci`):** a CI job saves both lists as artifacts and posts the diff on the PR.

### 13.3 `required` `new` Plugins with no other check
| Plugin | Manual check | Pass when | Auto |
|---|---|---|---|
| `rendering` (PDF) | Find entry points: `grep -rn "pdfRenderingService\|renderPdf" grails-app`. Open one in the browser. | File starts with `%PDF-`, and there's no `MockHttpServletRequest` `ClassNotFoundException` in the log (OBS-372) | `playwright` |
| `quartz-monitor` | Open `$NEW/quartz` as admin, then as a non-admin | Admin sees the job list. Non-admin is denied. | `playwright` |
| `grails-console` | Open `$NEW/console` as admin and run `1 + 1`. Repeat as non-admin and logged out. | Admin gets `2`. Others are denied or redirected to login. | `playwright` |
| `ajax-tags` | Find pages: `grep -rlnE "formRemote\|remoteLink\|remoteFunction" grails-app/views`. Click each link or form. | The request returns 200 and the target element updates | `playwright` (`waitForResponse`) |
| `browser-detection` | Find pages: `grep -rn "browser:is" grails-app/views`. Load one with `curl -A "<Android UA>"` and with a desktop UA. | The two responses differ the same way on both images | `playwright` |

### 13.4 `required` `new` Labels and barcodes
- **Find:** `grep -rnE "zxing|BarcodeFormat|ZebraUtils|labelary" grails-app src/main`
- **Barcode (zxing):** request the barcode image for a known value.
  Pass when it returns `image/png` and `zbarimg barcode.png` decodes to the same value.
- **ZPL (zebra-zpl):** generate a label.
  Pass when the ZPL starts with `^XA` and ends with `^XZ`, and the Labelary preview returns a PNG.
  If a Zebra printer is available, print one too.
- **Auto (`playwright`):** compare the ZPL text from both images. It should match exactly.

### 13.5 `required` `new` API clients
- **openboxes-mobile:** point a dev build at `$NEW`. Run login → choose location → pick → pack.
  Pass when there are no errors and the data matches the web UI.
- **VVG eASN (n8n):** replay a known eASN CSV through the test n8n workflow against `$NEW`.
  Pass when the resulting inbound shipment matches the one created on `$OLD`.
- **Auto (`playwright`):** list the endpoints the mobile app calls, from its API client code, and add an API spec that checks each response shape on both images.

### 13.6 `new` Dates and timezones (joda-time, jadira, jsr310)
- **Manual:** create a shipment with expected date `2026-03-08` (US daylight-saving switch) and a lot expiring `2026-12-31`.
  Check the dates in the UI, in the API JSON and in SQL (`SELECT expected_shipping_date FROM shipment WHERE id = ...`).
- Repeat with the JVM set to `-Duser.timezone=UTC`, then `America/Chicago`.
- **Pass when:** the same date shows everywhere, with no off-by-one day.
- **Auto (`playwright`):** POST the dates, GET them back, and compare across images.

### 13.7 `new` Character encoding
- **Manual:** import a product CSV saved twice, once as UTF-8 and once as Windows-1252.
  Use names like `Paracétamol 500 mg`, `Ибупрофен` and `डोलो`.
- **Pass when:**
  - the names look right in the UI
  - `SELECT HEX(name)` shows `utf8mb4` bytes
  - `pdftotext` on a product PDF contains the names
- **Auto (`playwright`):** keep the fixture CSVs in the repo, import them, and check the names in the API response.

### 13.8 `new` Caching (`@Cacheable`, ehcache)
- **Find:** `grep -rn "@Cacheable\|@CacheEvict" grails-app src/main`
- **Manual:** load a cached value, edit the record behind it, then reload.
  Pass when the new value shows right away, or after the documented expiry.
  The hit counts in Administration → Cache should also go up.

### 13.9 `required` `G7` `new` Cookies, headers and sessions
- **Manual:** compare the response headers on both images with `curl -sI "$NEW/" | sort`, then the same for `$OLD`.
- After logging in, the `JSESSIONID` cookie should keep the same `Path`, `Secure`, `HttpOnly` and `SameSite` flags as before.
- Leave a session idle past the configured timeout. The next click should redirect to login.
- **Auto (`playwright`):** check the flags returned by `context.cookies()`, and diff the response headers between images.

### 13.10 `required` `G7` `new` Health and release info
- **Manual:** Spring Boot 3 moved the endpoints under `/actuator`.
  - Check that `$OLD/health` and `$NEW/actuator/health` return `UP`.
  - Check that `/info` (or `/actuator/info`) includes `git.commit.id`, matching the image's commit.
- Trigger a test error and check that the Sentry event's `release` tag matches the commit.
- Check whether any uptime monitors or load balancers poll `/health`. They need the new path.
- **Auto (`playwright`):** API spec with a different path per image.

## 14. `build.gradle` problems to fix

- [ ] `required` `new` **OWASP check can never fail.** `failBuildOnCVSS = 11` is above the CVSS maximum of 10.
  1. Run `./gradlew dependencyCheckAnalyze` and read `build/reports/dependency-check-report.html` to see the current count.
  2. Set the threshold to `7`, and add suppressions for accepted findings.
- [ ] `required` `G7` `new` **Java 8 pins.** Run `grep -nE "sourceCompatibility|targetCompatibility|asmVersion|jgit|toolVersion|version = '14" build.gradle gradle.properties`.
  - Raise each one on the upgrade branch.
  - Then `JAVA_HOME=<jdk17> ./gradlew clean build jacocoTestReport` should pass. Jacoco 0.7.6 fails on Java 17, which is the quickest way to confirm.
