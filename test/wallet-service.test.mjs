import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { WalletService } from '../src/core/wallet-service.mjs';
import { GENESIS } from '../src/core/config.mjs';
import { deriveAccount } from '../src/core/crypto.mjs';

const PASSWORD = 'local-test-password-only';
const tip = { chain:'testnet4',height:999,hash:'a'.repeat(64),mediantime:1789500000,genesis_hash:GENESIS.testnet4 };
class Backend extends EventEmitter {
  constructor() { super(); this.socket = {}; this.calls = []; this.negative = false; }
  async request(method, params) {
    this.calls.push([method,params]);
    if(method==='getchaintip')return tip;
    if(method==='getaddressbalance')return {tip,address:params.address,unit:'connects',confirmed:'10000000000',available_confirmed:'0',immature:'0',pending_delta:this.negative?'-10000000000':'0'};
    if(['getaddresshistory','getaddressutxos'].includes(method))return {tip,address:params.address,unit:'connects',items:[],next_cursor:null};
    throw new Error('Unexpected mock RPC request '+method);
  }
  close() { this.socket=null; }
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(),'beauty-service-test-'));
  const service = new WalletService({directory,clientFactory:()=>new Backend()});
  await service.initialize();
  t.after(async()=>{await service.close();assert.ok(resolve(directory).startsWith(resolve(tmpdir())+ '\\beauty-service-test-') || resolve(directory).startsWith(resolve(tmpdir())+'/beauty-service-test-'));await rm(directory,{recursive:true,force:true});});
  return service;
}
async function create(service) {
  const setup=await service.prepareWallet({name:'Test wallet',password:PASSWORD,wordCount:12});
  const words=setup.mnemonic.split(' ');
  const answers=Object.fromEntries(setup.checkIndexes.map(index=>[index,words[index]]));
  await service.confirmWallet({setupId:setup.setupId,answers});
  await service.refresh();
  return setup;
}
test('wallet creation requires backup verification and writes only encrypted data',async t=>{
  const s=await fixture(t);
  const setup=await s.prepareWallet({name:'Test wallet',password:PASSWORD,wordCount:18});
  await assert.rejects(s.confirmWallet({setupId:setup.setupId,answers:{}}),/backup words/);
  assert.equal(s.walletExists,false);
  s.cancelSetup();
  const created=await create(s);
  assert.equal(s.getState().phase,'unlocked');
  assert.equal(s.getState().claims.enabled,false);
  assert.match(s.getState().wallet.address,/^tcc1p/);
  assert.match(s.getState().wallet.qrDataUrl,/^data:image\/png;base64,/);
  const file=await readFile(s.vaultFile,'utf8');
  assert.ok(!file.includes(created.mnemonic));assert.ok(!file.includes(PASSWORD));
  assert.ok(!JSON.stringify(s.getState()).includes(created.mnemonic));
  assert.ok(s.rpc.calls.every(([,params])=>!JSON.stringify(params ?? {}).includes(created.mnemonic)));
});
test('negative pending deltas render exactly; locks invalidate previews and remove secrets',async t=>{
  const s=await fixture(t);await create(s);
  s.rpc.negative=true;await s.refresh();
  assert.equal(s.getState().wallet.balance.pending,'-2');
  s.preview={previewId:'stale'};
  await s.lock();
  assert.equal(s.getState().phase,'locked');assert.equal(s.getState().wallet,null);assert.equal(s.session,null);assert.equal(s.preview,null);
  await assert.rejects(s.getRecoveryPhrase({password:PASSWORD}),/locked/);
  await assert.rejects(s.unlock({password:'not-the-password'}),/incorrect password/);
  await s.unlock({password:PASSWORD});await s.refresh();assert.equal(s.getState().phase,'unlocked');
});
test('locking during password derivation cancels unlock without reviving keys',async t=>{
  const s=await fixture(t);await create(s);await s.lock();
  const pending=s.unlock({password:PASSWORD});await s.lock();
  await assert.rejects(pending,/cancelled/);assert.equal(s.session,null);
});
test('receive rotation persists and a stale review never broadcasts',async t=>{
  const s=await fixture(t);await create(s);
  const old=s.getState().wallet.address;
  const next=await s.newAddress();assert.notEqual(next.address,old);
  await s.lock();await s.unlock({password:PASSWORD});await s.refresh();
  assert.equal(s.getState().wallet.address,next.address);
  await assert.rejects(s.confirmSend({previewId:'invented'}),/expired/);
  assert.ok(s.rpc.calls.every(([method])=>method!=='sendrawtransaction'));
});
test('restoration keeps watching unused addresses and finds a later payment at the gap edge',async t=>{
  const s=await fixture(t);
  const mnemonic='abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  await s.restoreWallet({name:'Restored',password:PASSWORD,mnemonic});await s.refresh();
  assert.equal(s.session.data.scanLookahead,true);
  assert.ok(s.accounts.some(a=>a.change===0&&a.index===19));
  assert.ok(s.accounts.some(a=>a.change===1&&a.index===19));
  const account=deriveAccount(mnemonic,{index:19,change:0});account.privateKey.fill(0);
  const original=s.rpc.request.bind(s.rpc);
  s.rpc.request=async(method,params)=>{
    if(method==='getaddresshistory'&&params.address===account.address)return {tip,address:account.address,unit:'connects',items:[{txid:'b'.repeat(64),status:'confirmed',block_height:10,confirmations:990,received:'10000000000',spent:'0',balance_delta:'10000000000'}],next_cursor:null};
    return original(method,params);
  };
  await s.refresh();
  assert.equal(s.history.length,1);assert.equal(s.history[0].amount,'1');
  assert.equal(s.session.data.lastUsedReceive,19);
  assert.ok(s.accounts.some(a=>a.change===0&&a.index===39));
});

test('late network and QR completions cannot repopulate locked state',async t=>{
  const s=await fixture(t);await create(s);
  let complete;
  s.rpc.request=()=>new Promise(resolve=>{complete=resolve;});
  const network=s.ensureNetwork();
  const qr=s.makeQR();
  await s.lock();complete(tip);
  await assert.rejects(network,/locked or changed/);await qr;
  assert.equal(s.getState().network.status,'offline');
  assert.equal(s.qrDataUrl,null);assert.equal(s.session,null);
});

test('lock emits cleared secrets before slow helper shutdown and close drains encrypted writes',async t=>{
  const s=await fixture(t);await create(s);
  let finishStop, finishWrite;
  const originalStop=s.engine.stop.bind(s.engine);
  s.engine.stop=()=>new Promise(resolve=>{finishStop=resolve;});
  s.persisting=new Promise(resolve=>{finishWrite=resolve;});
  const states=[];s.on('state',state=>states.push(state));
  let closed=false;const closing=s.close().then(()=>{closed=true;});
  assert.ok(states.some(state=>state.phase==='locked'&&state.wallet===null));
  assert.equal(closed,false);finishStop();
  await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,false);
  finishWrite();await closing;assert.equal(closed,true);
  s.engine.stop=originalStop;
});

test('appearance persists without touching the wallet, connection, claims or payment review',async t=>{
  const s=await fixture(t);await create(s);
  const epoch=s.epoch, rpc=s.rpc, engine=s.engine;
  const encrypted=await readFile(s.vaultFile,'utf8');
  const preview=s.preview={previewId:'preserve-me',epoch};
  engine.start();
  for(const theme of ['dark','light','system']) {
    const result=await s.setTheme({theme});
    assert.equal(result.config.theme,theme);
    assert.equal(s.epoch,epoch);assert.equal(s.rpc,rpc);assert.equal(s.engine,engine);
    assert.equal(engine.enabled,true);assert.equal(s.preview,preview);
    assert.equal(await readFile(s.vaultFile,'utf8'),encrypted);
    assert.equal(JSON.parse(await readFile(join(s.directory,'config.json'),'utf8')).theme,theme);
  }
  await assert.rejects(s.setTheme({theme:'invalid'}),/appearance/);
  assert.equal(s.config.theme,'system');assert.equal(s.preview,preview);
});

test('appearance can be saved before onboarding or while locked, without exposing a session',async t=>{
  const s=await fixture(t);
  await s.setTheme({theme:'dark'});assert.equal(s.getState().phase,'welcome');
  assert.equal(s.session,null);assert.equal(s.walletExists,false);
  await create(s);await s.lock();
  await s.setTheme({theme:'light'});assert.equal(s.getState().phase,'locked');
  assert.equal(s.session,null);assert.equal(s.getState().wallet,null);
});
