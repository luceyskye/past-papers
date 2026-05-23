import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

const envPath = path.resolve(process.cwd(), '../../.env.local');
if (fs.existsSync(envPath)) dotenv.config({ path: envPath });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  { db: { schema: 'visita_scholar' } }
);

async function run() {
  console.log("Testing connection...");
  const { data, error } = await supabase
    .from('past_papers')
    .select('*')
    .limit(1);

  if (error) {
    console.error("SUPABASE ERROR:", error);
    console.error("ERROR KEYS:", Object.keys(error));
    console.error("STRINGIFIED:", JSON.stringify(error));
  } else {
    console.log("SUCCESS:", data);
  }
}

run();
