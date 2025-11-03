#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import Stripe from 'stripe';
import sgMail from '@sendgrid/mail';
import fetch from 'node-fetch';
import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';

const REQUIRED_VARS = [
  'OPENAI_API_KEY',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'STRIPE_PUBLISHABLE_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_PRICE_RESPONSE',
  'STRIPE_WEBHOOK_SECRET',
  'SENDGRID_API_KEY',
  'SITE_URL',
  'ENVIRONMENT',
];

async function loadEnvFromNetlify() {
  try {
    // First check if already linked
    let isLinked = false;
    try {
      const statusOutput = execSync('netlify status --json', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
      const status = JSON.parse(statusOutput);
      isLinked = Boolean(status.siteInfo?.id);
    } catch (err) {
      // Not linked, try to auto-link using git remote
      try {
        const gitRemote = execSync('git remote get-url origin', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
        // Try to link using the git remote (this works if repo is connected in Netlify)
        try {
          execSync(`netlify link --git`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
          isLinked = true;
        } catch (linkErr) {
          // Try to find by repo name
          const repoName = gitRemote.split('/').pop().replace('.git', '');
          const sitesOutput = execSync('netlify sites:list --json', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
          const sites = JSON.parse(sitesOutput);
          
          if (Array.isArray(sites)) {
            // Find site that might match (check all sites, user can specify if multiple)
            const possibleSites = sites.filter(site => 
              site.name?.toLowerCase().includes('audit') ||
              site.name?.toLowerCase().includes('response')
            );
            
            if (possibleSites.length === 1) {
              // Only one match, auto-link
              try {
                execSync(`netlify link --id ${possibleSites[0].id}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
                isLinked = true;
              } catch (linkErr2) {
                // Link failed
              }
            }
          }
        }
      } catch (linkAttemptErr) {
        // Couldn't auto-link
      }
    }

    if (!isLinked) {
      return false;
    }

    // Fetch each required variable's value
    let loadedCount = 0;
    for (const varName of REQUIRED_VARS) {
      if (!process.env[varName]) {
        try {
          const valueOutput = execSync(`netlify env:get ${varName}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
          const value = valueOutput.trim();
          if (value && !value.includes('Error') && !value.includes('not found') && value.length > 0) {
            process.env[varName] = value;
            loadedCount++;
          }
        } catch (err) {
          // Variable might not exist, continue
        }
      }
    }
    
    return loadedCount > 0;
  } catch (error) {
    // Site not linked or CLI error
    return false;
  }
}

function loadEnvFromFile() {
  // Try to load from .env file
  if (existsSync('.env')) {
    const envContent = readFileSync('.env', 'utf-8');
    const lines = envContent.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
        const [key, ...valueParts] = trimmed.split('=');
        const value = valueParts.join('=').replace(/^["']|["']$/g, '');
        if (key && value && !process.env[key]) {
          process.env[key] = value;
        }
      }
    }
  }
}

// Map alternative variable names
function mapEnvVars() {
  // STRIPE_PUBLIC_KEY -> STRIPE_PUBLISHABLE_KEY
  if (process.env.STRIPE_PUBLIC_KEY && !process.env.STRIPE_PUBLISHABLE_KEY) {
    process.env.STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLIC_KEY;
  }
  // STRIPE_PRICE_ID -> STRIPE_PRICE_RESPONSE (fallback)
  if (process.env.STRIPE_PRICE_ID && !process.env.STRIPE_PRICE_RESPONSE) {
    process.env.STRIPE_PRICE_RESPONSE = process.env.STRIPE_PRICE_ID;
  }
}

function logEnvStatus() {
  const results = {};
  for (const key of REQUIRED_VARS) {
    const present = Boolean(process.env[key] && String(process.env[key]).trim());
    results[key] = present;
    console.log(`${present ? '✅' : '❌'} ${present ? 'Found' : 'Missing'}: ${key}`);
  }
  return results;
}

function nowMs() {
  const hr = process.hrtime.bigint();
  return Number(hr / 1000000n);
}

async function checkOpenAI() {
  const start = nowMs();
  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const res = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'Generate a sample sentence.' }],
      max_tokens: 20,
      temperature: 0.5,
    });
    const text = res.choices?.[0]?.message?.content || '';
    const ok = Boolean(text && text.length > 0);
    return { ok, ms: nowMs() - start, detail: ok ? 'OK' : 'Empty response' };
  } catch (e) {
    return { ok: false, ms: nowMs() - start, detail: e.message || String(e) };
  }
}

async function checkSupabase() {
  const start = nowMs();
  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const payload = { checked_at: new Date().toISOString(), status: 'ok' };
    const { error } = await supabase.from('system_check').insert(payload);
    if (error) {
      return { ok: false, ms: nowMs() - start, detail: `Insert failed: ${error.message}` };
    }
    return { ok: true, ms: nowMs() - start, detail: 'Inserted dummy record' };
  } catch (e) {
    return { ok: false, ms: nowMs() - start, detail: e.message || String(e) };
  }
}

async function checkStripe() {
  const start = nowMs();
  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
    const priceId = process.env.STRIPE_PRICE_RESPONSE;
    const price = await stripe.prices.retrieve(priceId);
    let productObj = null;
    if (typeof price.product === 'string') {
      productObj = await stripe.products.retrieve(price.product);
    } else {
      productObj = price.product;
    }
    const ok = Boolean(productObj && productObj.id);
    return { ok, ms: nowMs() - start, detail: ok ? `Product ${productObj.id}` : 'No product returned' };
  } catch (e) {
    return { ok: false, ms: nowMs() - start, detail: e.message || String(e) };
  }
}

async function checkSendGrid() {
  const start = nowMs();
  try {
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
    // Lightweight, no-send endpoint to verify API reachability
    const [response] = await sgMail.client.request({ method: 'GET', url: '/v3/user/profile' });
    const ok = response?.statusCode && response.statusCode < 400;
    return { ok, ms: nowMs() - start, detail: ok ? 'Email API reachable' : `Status ${response?.statusCode}` };
  } catch (e) {
    return { ok: false, ms: nowMs() - start, detail: e.message || String(e) };
  }
}

async function checkSiteUrl() {
  const start = nowMs();
  try {
    const url = process.env.SITE_URL;
    const res = await fetch(url, { method: 'GET' });
    const ok = res.status === 200;
    return { ok, ms: nowMs() - start, detail: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, ms: nowMs() - start, detail: e.message || String(e) };
  }
}

function printReport(title, result) {
  const status = result.ok ? '✅' : '❌';
  console.log(`${status} ${title}: ${result.ok ? 'OK' : 'FAILED'} (${result.ms} ms)${result.detail ? ` - ${result.detail}` : ''}`);
}

async function main() {
  console.log('🔍 Loading environment variables...\n');
  
  // Try to load from Netlify first
  const netlifyLoaded = await loadEnvFromNetlify();
  if (netlifyLoaded) {
    console.log('✅ Loaded environment variables from Netlify\n');
  } else {
    console.log('⚠️  Netlify site not linked or unable to fetch environment variables.\n');
    console.log('   To test with Netlify environment variables:');
    console.log('   1. Run: netlify link');
    console.log('   2. Select your site from the list');
    console.log('   3. Run this check again: npm run prod:check\n');
    console.log('   Trying .env file as fallback...\n');
    loadEnvFromFile();
  }
  
  // Map alternative variable names
  mapEnvVars();
  
  console.log('== Environment Variables ==');
  const envStatus = logEnvStatus();

  console.log('\n== Integration Checks ==');
  const checks = await Promise.all([
    checkOpenAI(),
    checkSupabase(),
    checkStripe(),
    checkSendGrid(),
    checkSiteUrl(),
  ]);

  const report = {
    openai: checks[0],
    supabase: checks[1],
    stripe: checks[2],
    sendgrid: checks[3],
    site: checks[4],
  };

  printReport('OpenAI', report.openai);
  printReport('Supabase', report.supabase);
  printReport('Stripe', report.stripe);
  printReport('SendGrid', report.sendgrid);
  printReport('SITE_URL', report.site);

  // Calculate average response time
  const responseTimes = Object.values(report).map(r => r.ms);
  const avgTime = Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length);
  console.log(`\nAverage response time: ${avgTime} ms`);

  const missingKeys = Object.entries(envStatus)
    .filter(([, present]) => !present)
    .map(([k]) => k);

  if (missingKeys.length) {
    console.log(`\nMissing or invalid keys: ${missingKeys.join(', ')}`);
  }

  const allIntegrationsOk = Object.values(report).every(r => r.ok);
  const allEnvOk = missingKeys.length === 0;

  if (allEnvOk && allIntegrationsOk) {
    console.log('\n✅ All environment variables and integrations are working — ready for production deploy.');
    process.exit(0);
  } else {
    console.log('\n❌ One or more checks failed. See details above.');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('Unexpected error in readiness check:', e);
  process.exit(1);
});


