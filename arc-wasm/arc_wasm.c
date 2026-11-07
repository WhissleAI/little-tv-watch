/* arc_tv: Arc Mini live stream -> one JSON object per line on stdout (for tvwatch.py).
 *   arecord -q -D plughw:1 -f S16_LE -r 16000 -c 1 -t raw | ./arc_tv MINI_DIR [--domain nba] [--names names.txt]
 *       [--threads 3] [--partial-ms 1000] [--partial-window 7] [--context context.txt] [--bias bias.txt] [--beams 4]
 *       [--frames 0.2]
 * Records: {"k":"partial"|"final"|"tags"|"event"|"frame", ...}. --frames F: every 100 ms frame of the trunk's read-out,
 * the labels at p >= F (sports events "ev_rec:event.sports.score.recent", game state, affect, speaker roles, sounds). names.txt: one per line, "Name|kind|alias1,alias2" (kind and
 * aliases optional; kinds: person team organization place work_product event_name other). */
#define _POSIX_C_SOURCE 200809L
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>

#include "arc.h"
#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#else
#define EMSCRIPTEN_KEEPALIVE
#endif
static FILE* g_out;

static void js(const char* s) {
  fputc('"', g_out);
  for (; s && *s; ++s) {
    unsigned char c = (unsigned char)*s;
    if (c == '"' || c == '\\') fprintf(g_out, "\\%c", c);
    else if (c == '\n') fputs("\\n", g_out);
    else if (c < 0x20) fprintf(g_out, "\\u%04x", c);
    else fputc(c, g_out);
  }
  fputc('"', g_out);
}

static void utt(const char* k, const arc_stream_out* o) {
  const arc_utt* u = o->utt;
  fprintf(g_out, "{\"k\":\"%s\",\"id\":%d,\"t\":%.2f,\"start\":%.2f,\"end\":%.2f,\"text\":", k, o->id, o->audio_s, u->start,
         u->end);
  js(u->text);
  fputs(",\"tags\":[", g_out);
  for (int i = 0; i < u->n_tags; ++i) {
    if (i) fputc(',', g_out);
    fputs("{\"tag\":", g_out);
    js(u->tags[i].tag);
    fputs(",\"text\":", g_out);
    js(u->tags[i].text);
    fprintf(g_out, ",\"wb\":%d,\"we\":%d}", u->tags[i].word_begin, u->tags[i].word_end);
  }
  fprintf(g_out, "],\"intent\":");
  js(u->intent.label ? u->intent.label : "");
  fprintf(g_out, ",\"act\":");
  js(u->act.label ? u->act.label : "");
  fprintf(g_out, ",\"tags_final\":%d}\n", o->tags_final);
}

static float g_frame_floor = -1;

static void frame(const arc_frame* f) {
  int any = 0;
  for (int i = 0; i < f->n_labels; ++i) {
    const char* l = f->labels[i];
    if (f->p[i] < g_frame_floor || !strncmp(l, "entity.", 7) || !strncmp(l, "discourse.intent.", 17) ||
        !strncmp(l, "safety.pii.", 11) || !strcmp(l, "meta.speech"))
      continue;
    if (!any) fprintf(g_out, "{\"k\":\"frame\",\"t\":%.1f,\"sp\":%.2f,\"p\":{", f->t, f->speech);
    fprintf(g_out, "%s", any ? "," : "");
    js(l);
    fprintf(g_out, ":%.3f", f->p[i]);
    any = 1;
  }
  if (any) fprintf(g_out, "}}\n");
}

static void on_output(const arc_stream_out* o, void* user) {
  (void)user;
  switch (o->kind) {
    case ARC_OUT_PARTIAL: utt("partial", o); break;
    case ARC_OUT_FINAL: utt("final", o); break;
    case ARC_OUT_TAGS: utt("tags", o); break;
    case ARC_OUT_FRAME:
      if (o->frame) frame(o->frame);
      break;
    case ARC_OUT_EVENT:
      fprintf(g_out, "{\"k\":\"event\",\"t\":%.2f,\"label\":", o->audio_s);
      js(o->event->label);
      fprintf(g_out, ",\"start\":%.2f,\"end\":%.2f,\"p\":%.3f}\n", o->event->start, o->event->end, o->event->p);
      break;
    default: return;
  }
  fflush(g_out);
}

/* names.txt -> arc_set_names (also the decoder's bias list); kept so a context change can restore the bias */
static arc_name_entry g_ent[512];
static int g_n_ent = -1;

static int load_names(arc_engine* e, const char* path) {
  FILE* f = fopen(path, "r");
  if (!f) { perror(path); return -1; }
  enum { MAXN = 512, MAXA = 8 };
  static arc_name_entry ent[MAXN];
  static const char* al[MAXN][MAXA];
  char line[512];
  int n = 0;
  while (n < MAXN && fgets(line, sizeof line, f)) {
    line[strcspn(line, "\r\n")] = 0;
    if (!line[0] || line[0] == '#') continue;
    char* p = strdup(line);
    char* kind = strchr(p, '|');
    char* aliases = NULL;
    if (kind) { *kind++ = 0; if ((aliases = strchr(kind, '|'))) *aliases++ = 0; if (!*kind) kind = NULL; }
    ent[n] = (arc_name_entry){.name = p, .kind = kind, .aliases = al[n]};
    for (char* a = aliases ? strtok(aliases, ",") : NULL; a && ent[n].n_aliases < MAXA; a = strtok(NULL, ","))
      al[n][ent[n].n_aliases++] = a;
    ++n;
  }
  fclose(f);
  fprintf(stderr, "arc_tv: %d names from %s\n", n, path);
  memcpy(g_ent, ent, sizeof(ent[0]) * n);
  g_n_ent = n;
  return arc_set_names(e, ent, n);
}

/* bias.txt: phrases the decoder is pulled towards (the watchlist's names and aliases, the sport's alert words:
 * "touchdown", "interception"). Replaces the list arc_set_names made, so it carries the names too. */
static const char* g_bias_path;

static void load_bias(arc_engine* e) {
  enum { MAXB = 256 };
  static char* ph[MAXB];
  int n = 0;
  FILE* f = g_bias_path ? fopen(g_bias_path, "r") : NULL;
  if (!f) return;
  char line[256];
  while (n < MAXB && fgets(line, sizeof line, f)) {
    line[strcspn(line, "\r\n")] = 0;
    if (!line[0] || line[0] == '#') continue;
    free(ph[n]);
    ph[n++] = strdup(line);
  }
  fclose(f);
  arc_set_bias(e, (const char* const*)ph, n);
  fprintf(stderr, "arc_tv: bias %d phrases\n", n);
}

/* context.txt ("Name|kind" per line, written by tvwatch.py from the last 30 minutes) -> the decoder's context prompt,
 * with auto_prev (the last minute's words). arc_set_context replaces the bias list, so the watchlist's is set again. */
static void load_context(arc_engine* e, const char* path) {
  enum { MAXC = 48 };
  static char* nm[MAXC];
  static char* kd[MAXC];
  int n = 0;
  FILE* f = path ? fopen(path, "r") : NULL;
  char line[256];
  while (f && n < MAXC && fgets(line, sizeof line, f)) {
    line[strcspn(line, "\r\n")] = 0;
    if (!line[0] || line[0] == '#') continue;
    char* k = strchr(line, '|');
    if (k) *k++ = 0;
    free(nm[n]);
    free(kd[n]);
    nm[n] = strdup(line);
    kd[n] = k && *k ? strdup(k) : NULL;
    ++n;
  }
  if (f) fclose(f);
  arc_set_context(e, (const char* const*)nm, (const char* const*)kd, n, NULL, 0, NULL, NULL, 1);
  if (g_n_ent > 0) arc_set_names(e, g_ent, g_n_ent);
  load_bias(e);
  fprintf(stderr, "arc_tv: context %d names + last minute\n", n);
}


/* ---------------------------------------------------------------- the page's API (one stream at a time)
 * arcw_open(model_dir, threads, domain, partial_ms, partial_window_s, frame_floor, names_path, bias_path) -> 0 ok
 * arcw_push(int16 pcm, n) -> 0 ok; records accumulate as JSON lines (same as arc_tv's stdout)
 * arcw_take() -> the JSON lines since the last take (owned by the module until the next take)
 * arcw_context(path) reloads the context file; arcw_finish() flushes the last utterance; arcw_close(). */
static arc_engine* g_e;
static arc_stream* g_s;
static char* g_buf;
static size_t g_len;
static char* g_taken;
static arc_stream_config g_c;
static char g_domain[64];

static void out_open(void) { g_out = open_memstream(&g_buf, &g_len); }

EMSCRIPTEN_KEEPALIVE int arcw_open(const char* dir, int threads, const char* domain, int partial_ms, float window_s,
                                   float floor, const char* names, const char* bias) {
  char err[512];
  if (!g_out) out_open();
  if (!g_e && !(g_e = arc_create(dir, threads, err, sizeof err))) { fprintf(stderr, "arc: %s\n", err); return 1; }
  if (g_s) { arc_stream_finish(g_s); arc_stream_close(g_s); g_s = NULL; }
  g_frame_floor = floor;
  g_bias_path = bias && *bias ? bias : NULL;
  g_n_ent = -1;
  if (names && *names && load_names(g_e, names)) { fprintf(stderr, "arc: %s\n", arc_last_error()); return 1; }
  load_context(g_e, NULL);
  memset(&g_c, 0, sizeof g_c);
  snprintf(g_domain, sizeof g_domain, "%s", domain && *domain ? domain : "news");
  g_c.mode = ARC_STREAM_FULL;
  g_c.domain = g_domain;
  g_c.partial_ms = partial_ms;
  g_c.partial_window_s = window_s;
  g_c.bias_names = (names && *names) || g_bias_path != NULL;
  g_c.on_output = on_output;
  g_c.events = 1;
  g_c.frames = g_frame_floor >= 0;
  if (!(g_s = arc_stream_open(g_e, &g_c))) { fprintf(stderr, "arc: %s\n", arc_last_error()); return 1; }
  return 0;
}

EMSCRIPTEN_KEEPALIVE int arcw_push(const int16_t* raw, int n) {
  static float pcm[16000];
  if (!g_s) return 1;
  for (int off = 0; off < n; off += 16000) {
    int k = n - off < 16000 ? n - off : 16000;
    for (int i = 0; i < k; ++i) pcm[i] = raw[off + i] / 32768.0f;
    if (arc_stream_push(g_s, pcm, (size_t)k)) return 1;
  }
  return 0;
}

EMSCRIPTEN_KEEPALIVE const char* arcw_take(void) {
  fflush(g_out);
  free(g_taken);
  g_taken = g_len ? strndup(g_buf, g_len) : strdup("");
  fclose(g_out);
  free(g_buf);
  g_buf = NULL;
  g_len = 0;
  out_open();
  return g_taken;
}

EMSCRIPTEN_KEEPALIVE void arcw_context(const char* path) { if (g_e) load_context(g_e, path); }
EMSCRIPTEN_KEEPALIVE void arcw_finish(void) { if (g_s) arc_stream_finish(g_s); }
EMSCRIPTEN_KEEPALIVE void arcw_close(void) {
  if (g_s) { arc_stream_close(g_s); g_s = NULL; }
  if (g_e) { arc_destroy(g_e); g_e = NULL; }
}

#ifndef __EMSCRIPTEN__
/* native check of the same wrapper: arcw_test MINI_DIR < pcm > records */
int main(int argc, char** argv) {
  if (arcw_open(argv[1], argc > 2 ? atoi(argv[2]) : 1, "nba", 1000, 7, 0.2f, NULL, NULL)) return 1;
  int16_t raw[1600];
  size_t got;
  while ((got = fread(raw, 2, 1600, stdin)) > 0) { arcw_push(raw, (int)got); fputs(arcw_take(), stdout); }
  arcw_finish();
  fputs(arcw_take(), stdout);
  return 0;
}
#endif
