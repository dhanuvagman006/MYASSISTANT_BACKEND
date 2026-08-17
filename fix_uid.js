const fs = require('fs');
const path = require('path');
const glob = require('glob');

const files = glob.sync('src/**/*.js');
for (const file of files) {
  let content = fs.readFileSync(file, 'utf-8');
  
  // Replace:
  // function uid(req, res) {
  //   const id = Number(req.user?.sub);
  //   if (!Number.isInteger(id) || id <= 0) {
  //
  // With:
  // function uid(req, res) {
  //   let sub = req.user?.sub;
  //   if (sub === "anonymous-dev") sub = 0;
  //   const id = Number(sub);
  //   if (!Number.isInteger(id) || id < 0) {
  
  content = content.replace(
    /function uid\(req, res\) \{\s+const id = Number\(req\.user\?\.sub\);\s+if \(!Number\.isInteger\(id\) \|\| id <= 0\) \{/g,
    `function uid(req, res) {
  let sub = req.user?.sub;
  if (sub === "anonymous-dev") sub = 0;
  const id = Number(sub);
  if (!Number.isInteger(id) || id < 0) {`
  );

  // Also replace:
  // function uidOf(req) {
  //   const id = Number(req.user?.sub);
  //   if (!Number.isInteger(id) || id <= 0) return null;
  //   return id;
  // }
  
  content = content.replace(
    /function uidOf\(req\) \{\s+const id = Number\(req\.user\?\.sub\);\s+if \(!Number\.isInteger\(id\) \|\| id <= 0\) return null;\s+return id;\s+\}/g,
    `function uidOf(req) {
  let sub = req.user?.sub;
  if (sub === "anonymous-dev") sub = 0;
  const id = Number(sub);
  if (!Number.isInteger(id) || id < 0) return null;
  return id;
}`
  );
  
  // And `function uid(req)` which is basically the same as uidOf
  content = content.replace(
    /function uid\(req\) \{\s+const id = Number\(req\.user\?\.sub\);\s+if \(!Number\.isInteger\(id\) \|\| id <= 0\) return null;\s+return id;\s+\}/g,
    `function uid(req) {
  let sub = req.user?.sub;
  if (sub === "anonymous-dev") sub = 0;
  const id = Number(sub);
  if (!Number.isInteger(id) || id < 0) return null;
  return id;
}`
  );

  fs.writeFileSync(file, content);
}
