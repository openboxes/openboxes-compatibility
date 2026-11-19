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
