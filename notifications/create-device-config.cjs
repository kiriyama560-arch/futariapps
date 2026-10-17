// Offline helper. Writes secrets ONLY to an explicitly chosen private directory outside this repo.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const output=process.argv[2];
if(!output)throw Error('Pass a private output directory outside the repository.');
const dest=path.resolve(output),repo=path.resolve(__dirname,'..');
if(dest===repo || dest.startsWith(repo+path.sep))throw Error('Keep registration secrets outside the repository.');
fs.mkdirSync(dest,{recursive:true});
const file=path.join(dest,'device-registration.json');
const state={},devices={};
for(const m of ['A','B']){const token=crypto.randomBytes(32).toString('hex');state[m]={deviceHash:crypto.createHash('sha256').update(token).digest('hex'),topic:'fn-'+crypto.randomBytes(24).toString('hex')};devices[m]={registrationCode:token,topic:state[m].topic};}
fs.writeFileSync(file,JSON.stringify({scriptProperties:{ENABLED:'false',APP_ORIGIN:'https://kiriyama560-arch.github.io',STATE:JSON.stringify(state)},devices},null,2),{flag:'wx',mode:0o600});
console.log('Private registration file created. Contents were not printed.');
