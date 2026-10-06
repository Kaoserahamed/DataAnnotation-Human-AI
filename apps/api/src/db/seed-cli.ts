/**
 * CLI: seed a self-contained demo workspace.
 *
 * Creates four users (admin, two annotators, a reviewer), one project, and
 * eight datasets — one per supported modality. Items carrying an
 * `importedPrediction` (a stored model output from an offline batch) make the
 * pre-label → verify → gold flow visible immediately; the rest exercise the
 * deterministic heuristics.
 *
 * The seed password is read from SEED_PASSWORD env var. When unset, a random
 * 16-byte hex token is generated and printed to stdout at seed time so the
 * developer can copy it — no hardcoded fallback is shipped in source.
 *
 * Example:
 *   SEED_PASSWORD=mydevpass npm run db:seed
 *   # or just: npm run db:seed  (a random password will be printed)
 */

import { randomBytes } from 'node:crypto';
import { loadConfig } from '../config.js';
import { createDatabase, json } from './database.js';
import { runMigrations } from './migrate.js';
import { hashPassword } from '../lib/auth.js';

/** Use SEED_PASSWORD if provided, otherwise generate a random token. */
const PASSWORD = process.env['SEED_PASSWORD'] ?? randomBytes(16).toString('hex');

interface SeedItem {
  id: string;
  content: Record<string, unknown>;
}

interface SeedDataset {
  id: string;
  name: string;
  taskType: string;
  labelSchema: Record<string, unknown>;
  items: SeedItem[];
}

const DATASETS: SeedDataset[] = [
  {
    id: 'ds_sentiment',
    name: 'Product reviews (sentiment)',
    taskType: 'sentiment',
    labelSchema: { categories: ['positive', 'negative', 'neutral'] },
    items: [
      { id: 'itm_sent_01', content: { text: 'Absolutely love this jacket, great quality and fast shipping!' } },
      { id: 'itm_sent_02', content: { text: 'Terrible experience, the product broke after two days.' } },
      { id: 'itm_sent_03', content: { text: 'It arrived on time. Nothing special but it works.' } },
      {
        id: 'itm_sent_04',
        content: {
          text: 'Battery life is amazing and the screen is crisp.',
          importedPrediction: { taskType: 'sentiment', label: { label: 'positive' } },
          importedConfidence: 0.93,
        },
      },
      {
        id: 'itm_sent_05',
        content: {
          text: 'The charger was missing from the box, disappointed.',
          importedPrediction: { taskType: 'sentiment', label: { label: 'negative' } },
          importedConfidence: 0.81,
        },
      },
      { id: 'itm_sent_06', content: { text: 'Average toaster, does the job, nothing more.' } },
      { id: 'itm_sent_07', content: { text: 'Wonderful customer support, they refunded me immediately.' } },
      { id: 'itm_sent_08', content: { text: 'Horrible smell and the fabric feels cheap.' } },
      {
        id: 'itm_sent_09',
        content: {
          text: 'Works perfectly with my setup.',
          importedPrediction: { taskType: 'sentiment', label: { label: 'positive' } },
          importedConfidence: 0.62,
        },
      },
      { id: 'itm_sent_10', content: { text: 'Never buying from this store again, rude staff.' } },
      { id: 'itm_sent_11', content: { text: 'Good value for the price, recommended.' } },
      { id: 'itm_sent_12', content: { text: 'The package was damaged but the item inside was fine.' } },
    ],
  },
  {
    id: 'ds_ner',
    name: 'News entities (NER)',
    taskType: 'ner',
    labelSchema: { entityTypes: ['PERSON', 'ORG', 'DATE', 'MONEY'] },
    items: [
      { id: 'itm_ner_01', content: { text: 'Jane Smith met the board of Acme Corp on 2024-03-01 in Berlin.' } },
      { id: 'itm_ner_02', content: { text: 'Global Holdings invested $4,200,000 last January 15, 2023.' } },
      { id: 'itm_ner_03', content: { text: 'The quarterly report from Initech Ltd shows steady growth.' } },
      {
        id: 'itm_ner_04',
        content: {
          text: 'Alice Johnson signed a contract with Globex GmbH for $250,000 on 2023-11-02.',
          importedPrediction: {
            taskType: 'ner',
            label: [
              { text: 'Alice Johnson', start: 0, end: 13, label: 'PERSON' },
              { text: 'Globex GmbH', start: 34, end: 45, label: 'ORG' },
              { text: '$250,000', start: 50, end: 58, label: 'MONEY' },
            ],
          },
          importedConfidence: 0.88,
        },
      },
      { id: 'itm_ner_05', content: { text: 'Robert Brown announced the merger on 2024-06-30.' } },
      { id: 'itm_ner_06', content: { text: 'Umbrella Corp donated 5,000 USD to the fund.' } },
      { id: 'itm_ner_07', content: { text: 'Maria Garcia and Wei Zhang attended the summit.' } },
      { id: 'itm_ner_08', content: { text: 'Stark Industries reported revenue of $1.2 billion.' } },
      { id: 'itm_ner_09', content: { text: 'On December 5, 2022 the partnership with Wayne Enterprises began.' } },
      { id: 'itm_ner_10', content: { text: 'Oliver Jones left Soylent Corp in February 2021.' } },
    ],
  },
];

DATASETS.push(
  {
    id: 'ds_classify',
    name: 'Support tickets (classification)',
    taskType: 'text_classification',
    labelSchema: { categories: ['electronics', 'kitchen', 'books'] },
    items: [
      { id: 'itm_cls_01', content: { text: 'My laptop charger sparked and stopped working.' } },
      { id: 'itm_cls_02', content: { text: 'The blender leaks water from the base after use.' } },
      { id: 'itm_cls_03', content: { text: 'The novel I ordered arrived with torn pages.' } },
      {
        id: 'itm_cls_04',
        content: {
          text: 'Headphones disconnect randomly during calls.',
          importedPrediction: { taskType: 'text_classification', label: { label: 'electronics' } },
          importedConfidence: 0.91,
        },
      },
      { id: 'itm_cls_05', content: { text: 'Recipe book recommendation for beginners?' } },
      { id: 'itm_cls_06', content: { text: 'Oven mitts caught fire near the stove.' } },
      {
        id: 'itm_cls_07',
        content: {
          text: 'Tablet screen flickers when charging.',
          importedPrediction: { taskType: 'text_classification', label: { label: 'electronics' } },
          importedConfidence: 0.58,
        },
      },
      { id: 'itm_cls_08', content: { text: 'Can I get a replacement kettle lid?' } },
      { id: 'itm_cls_09', content: { text: 'Bluetooth speaker has no bass.' } },
      { id: 'itm_cls_10', content: { text: 'Novel arrives tomorrow?' } },
    ],
  },
  {
    id: 'ds_bbox',
    name: 'Street scenes (bounding boxes)',
    taskType: 'image_bbox',
    labelSchema: { regionLabels: ['person', 'car', 'dog'] },
    items: [
      {
        id: 'itm_box_01',
        content: {
          imageUrl: 'https://picsum.photos/seed/street1/640/480',
          importedPrediction: {
            taskType: 'image_bbox',
            label: [
              { x: 0.12, y: 0.2, width: 0.2, height: 0.55, label: 'person', confidence: 0.87 },
              { x: 0.55, y: 0.35, width: 0.3, height: 0.3, label: 'car', confidence: 0.79 },
            ],
          },
          importedConfidence: 0.84,
        },
      },
      {
        id: 'itm_box_02',
        content: {
          imageUrl: 'https://picsum.photos/seed/street2/640/480',
          importedPrediction: {
            taskType: 'image_bbox',
            label: [{ x: 0.4, y: 0.42, width: 0.25, height: 0.35, label: 'dog', confidence: 0.55 }],
          },
          importedConfidence: 0.55,
        },
      },
      { id: 'itm_box_03', content: { imageUrl: 'https://picsum.photos/seed/street3/640/480' } },
      {
        id: 'itm_box_04',
        content: {
          imageUrl: 'https://picsum.photos/seed/street4/640/480',
          importedPrediction: {
            taskType: 'image_bbox',
            label: [
              { x: 0.05, y: 0.3, width: 0.18, height: 0.5, label: 'person', confidence: 0.91 },
              { x: 0.6, y: 0.5, width: 0.35, height: 0.28, label: 'car', confidence: 0.88 },
            ],
          },
          importedConfidence: 0.9,
        },
      },
      { id: 'itm_box_05', content: { imageUrl: 'https://picsum.photos/seed/street5/640/480' } },
      { id: 'itm_box_06', content: { imageUrl: 'https://picsum.photos/seed/street6/640/480' } },
    ],
  },
);

DATASETS.push(
  {
    id: 'ds_seg',
    name: 'Aerial photos (segmentation)',
    taskType: 'image_segmentation',
    labelSchema: { regionLabels: ['road', 'building'] },
    items: [
      {
        id: 'itm_seg_01',
        content: {
          imageUrl: 'https://picsum.photos/seed/aerial1/640/480',
          importedPrediction: {
            taskType: 'image_segmentation',
            label: [
              { points: [[0.1, 0.6], [0.9, 0.55], [0.9, 0.75], [0.1, 0.8]], label: 'road' },
              { points: [[0.2, 0.1], [0.5, 0.12], [0.48, 0.4], [0.18, 0.38]], label: 'building' },
            ],
          },
          importedConfidence: 0.72,
        },
      },
      { id: 'itm_seg_02', content: { imageUrl: 'https://picsum.photos/seed/aerial2/640/480' } },
      { id: 'itm_seg_03', content: { imageUrl: 'https://picsum.photos/seed/aerial3/640/480' } },
      { id: 'itm_seg_04', content: { imageUrl: 'https://picsum.photos/seed/aerial4/640/480' } },
    ],
  },
  {
    id: 'ds_audio',
    name: 'Podcast clips (transcription)',
    taskType: 'audio_transcription',
    labelSchema: {},
    items: [
      {
        id: 'itm_aud_01',
        content: {
          audioUrl: 'https://www2.cs.uic.edu/~i101/SoundFiles/CantinaBand3.wav',
          durationMs: 6000,
          importedPrediction: {
            taskType: 'audio_transcription',
            label: [{ startMs: 0, endMs: 3200, text: 'Welcome back to the show.' }],
          },
          importedConfidence: 0.86,
        },
      },
      {
        id: 'itm_aud_02',
        content: {
          audioUrl: 'https://www2.cs.uic.edu/~i101/SoundFiles/CantinaBand6.wav',
          durationMs: 5000,
        },
      },
      {
        id: 'itm_aud_03',
        content: {
          audioUrl: 'https://www2.cs.uic.edu/~i101/SoundFiles/StarWars60.wav',
          durationMs: 4000,
        },
      },
      {
        id: 'itm_aud_04',
        content: {
          audioUrl: 'https://www2.cs.uic.edu/~i101/SoundFiles/imperial1.wav',
          durationMs: 4000,
        },
      },
    ],
  },
);

DATASETS.push(
  {
    id: 'ds_translate',
    name: 'Voice messages (translation)',
    taskType: 'audio_translation',
    labelSchema: { targetLanguage: 'en' },
    items: [
      {
        id: 'itm_tra_01',
        content: {
          audioUrl: 'https://example.com/audio/message1.mp3',
          importedPrediction: {
            taskType: 'audio_translation',
            label: { label: 'Please arrive before noon.' },
          },
          importedConfidence: 0.8,
        },
      },
      {
        id: 'itm_tra_02',
        content: {
          audioUrl: 'https://example.com/audio/message2.mp3',
          importedPrediction: {
            taskType: 'audio_translation',
            label: { label: 'The meeting was postponed.' },
          },
          importedConfidence: 0.57,
        },
      },
      { id: 'itm_tra_03', content: { audioUrl: 'https://example.com/audio/message3.mp3' } },
      { id: 'itm_tra_04', content: { audioUrl: 'https://example.com/audio/message4.mp3' } },
    ],
  },
  {
    id: 'ds_doc',
    name: 'Scanned forms (document annotation)',
    taskType: 'document_annotation',
    labelSchema: { categories: ['invoice', 'receipt', 'contract'] },
    items: [
      { id: 'itm_doc_01', content: { documentText: 'INVOICE #4521 - due 2024-05-10, total $1,250.00' } },
      { id: 'itm_doc_02', content: { documentText: 'RECEIPT: office supplies, paid by card.' } },
      {
        id: 'itm_doc_03',
        content: {
          documentText: 'SERVICE CONTRACT between parties, term 12 months.',
          importedPrediction: { taskType: 'document_annotation', label: { label: 'contract' } },
          importedConfidence: 0.89,
        },
      },
      { id: 'itm_doc_04', content: { documentText: 'Invoice for consulting hours, Q3.' } },
      { id: 'itm_doc_05', content: { documentText: 'Receipt: grocery purchase.' } },
      { id: 'itm_doc_06', content: { documentText: 'Contract renewal notice.' } },
    ],
  },
);

const USERS = [
  { id: 'usr_admin', email: 'admin@demo.local', name: 'Ada Admin', role: 'admin' },
  { id: 'usr_ann1', email: 'ann1@demo.local', name: 'Ana Annotator', role: 'annotator' },
  { id: 'usr_ann2', email: 'ann2@demo.local', name: 'Ben Annotator', role: 'annotator' },
  { id: 'usr_rev', email: 'reviewer@demo.local', name: 'Rita Reviewer', role: 'reviewer' },
] as const;

async function main(): Promise<void> {
  const config = loadConfig();
  const db = await createDatabase(config);
  try {
    await runMigrations(db);

    const existing = await db.query<{ count: string }>('SELECT count(*)::text AS count FROM users');
    if (Number(existing[0]?.count ?? 0) > 0) {
      console.log('seed skipped: database already contains users');
      return;
    }

    const passwordHash = await hashPassword(PASSWORD);
    await db.transaction(async (tx) => {
      for (const user of USERS) {
        await tx.execute(
          `INSERT INTO users (id, email, name, password_hash, role) VALUES ($1, $2, $3, $4, $5)`,
          [user.id, user.email, user.name, passwordHash, user.role],
        );
      }

      await tx.execute(
        `INSERT INTO projects (id, name, description, status, created_by)
         VALUES ('prj_demo', 'Demo - Product Feedback', 'Self-contained demo covering all eight modalities.', 'active', 'usr_admin')`,
      );

      for (const dataset of DATASETS) {
        await tx.execute(
          `INSERT INTO datasets (id, project_id, name, task_type, label_schema)
           VALUES ($1, 'prj_demo', $2, $3, $4)`,
          [dataset.id, dataset.name, dataset.taskType, json(dataset.labelSchema)],
        );
        for (const item of dataset.items) {
          await tx.execute(
            `INSERT INTO items (id, dataset_id, content, meta, split) VALUES ($1, $2, $3, '{}', 'pool')`,
            [item.id, dataset.id, json(item.content)],
          );
          await tx.execute(
            `INSERT INTO tasks (id, item_id, dataset_id, state) VALUES ($1, $2, $3, 'pending_prelabel')`,
            [`tsk_${item.id.slice(4)}`, item.id, dataset.id],
          );
        }
      }
    });

    const itemCount = DATASETS.reduce((sum, d) => sum + d.items.length, 0);
    console.log(
      `seeded ${USERS.length} users, 1 project, ${DATASETS.length} datasets, ${itemCount} items`,
    );
    console.log(`sign in with admin@demo.local / ${PASSWORD}`);
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  console.error('seed failed:', error);
  process.exitCode = 1;
});
