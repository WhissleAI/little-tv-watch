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

static void js(const char* s) {
  putchar('"');
  for (; s && *s; ++s) {
    unsigned char c = (unsigned char)*s;
    if (c == '"' || c == '\\') printf("\\%c", c);
    else if (c == '\n') fputs("\\n", stdout);
    else if (c < 0x20) printf("\\u%04x", c);
    else putchar(c);
  }
  putchar('"');
}

static void utt(const char* k, const arc_stream_out* o) {
  const arc_utt* u = o->utt;
  printf("{\"k\":\"%s\",\"id\":%d,\"t\":%.2f,\"start\":%.2f,\"end\":%.2f,\"text\":", k, o->id, o->audio_s, u->start,
         u->end);
  js(u->text);
  fputs(",\"tags\":[", stdout);
  for (int i = 0; i < u->n_tags; ++i) {
    if (i) putchar(',');
    fputs("{\"tag\":", stdout);
    js(u->tags[i].tag);
    fputs(",\"text\":", stdout);
    js(u->tags[i].text);
    printf(",\"wb\":%d,\"we\":%d}", u->tags[i].word_begin, u->tags[i].word_end);
  }
  printf("],\"intent\":");
  js(u->intent.label ? u->intent.label : "");
  printf(",\"act\":");
  js(u->act.label ? u->act.label : "");
  printf(",\"tags_final\":%d}\n", o->tags_final);
}

static float g_frame_floor = -1;

static void frame(const arc_frame* f) {
  int any = 0;
  for (int i = 0; i < f->n_labels; ++i) {
    const char* l = f->labels[i];
    if (f->p[i] < g_frame_floor || !strncmp(l, "entity.", 7) || !strncmp(l, "discourse.intent.", 17) ||
        !strncmp(l, "safety.pii.", 11) || !strcmp(l, "meta.speech"))
      continue;
    if (!any) printf("{\"k\":\"frame\",\"t\":%.1f,\"sp\":%.2f,\"p\":{", f->t, f->speech);
    printf("%s", any ? "," : "");
    js(l);
    printf(":%.3f", f->p[i]);
    any = 1;
  }
  if (any) printf("}}\n");
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
      printf("{\"k\":\"event\",\"t\":%.2f,\"label\":", o->audio_s);
      js(o->event->label);
      printf(",\"start\":%.2f,\"end\":%.2f,\"p\":%.3f}\n", o->event->start, o->event->end, o->event->p);
      break;
    default: return;
  }
  fflush(stdout);
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

int main(int argc, char** argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: arecord -q -f S16_LE -r 16000 -c 1 -t raw | arc_tv MINI_DIR [--domain D] [--names F] "
                    "[--threads N] [--partial-ms N]\n");
    return 2;
  }
  int threads = 3;
  const char* names = NULL;
  const char* context = NULL;
  arc_stream_config c = {0};
  c.mode = ARC_STREAM_FULL;
  c.domain = "news";
  c.partial_ms = 1000;
  for (int i = 2; i < argc; ++i) {
    if (!strcmp(argv[i], "--threads") && i + 1 < argc) threads = atoi(argv[++i]);
    else if (!strcmp(argv[i], "--partial-ms") && i + 1 < argc) c.partial_ms = atoi(argv[++i]);
    else if (!strcmp(argv[i], "--domain") && i + 1 < argc) c.domain = argv[++i];
    else if (!strcmp(argv[i], "--partial-window") && i + 1 < argc) c.partial_window_s = (float)atof(argv[++i]);
    else if (!strcmp(argv[i], "--names") && i + 1 < argc) names = argv[++i];
    else if (!strcmp(argv[i], "--context") && i + 1 < argc) context = argv[++i];
    else if (!strcmp(argv[i], "--bias") && i + 1 < argc) g_bias_path = argv[++i];
    else if (!strcmp(argv[i], "--beams") && i + 1 < argc) c.beams = atoi(argv[++i]);
    else if (!strcmp(argv[i], "--frames") && i + 1 < argc) g_frame_floor = (float)atof(argv[++i]);
  }
  char err[512];
  arc_engine* e = arc_create(argv[1], threads, err, sizeof err);
  if (!e) { fprintf(stderr, "arc: %s\n", err); return 1; }
  if (names && load_names(e, names)) { fprintf(stderr, "arc: %s\n", arc_last_error()); return 1; }
  load_context(e, context);   /* auto_prev on even without a file */
  c.bias_names = names != NULL || g_bias_path != NULL;
  c.on_output = on_output;
  c.events = 1;
  c.frames = g_frame_floor >= 0;
  arc_stream* s = arc_stream_open(e, &c);
  if (!s) { fprintf(stderr, "arc: %s\n", arc_last_error()); return 1; }
  fprintf(stderr, "arc_tv: ready (domain %s, %d threads)\n", c.domain, threads);
  enum { CHUNK = 1600 };   /* 100 ms */
  int16_t raw[CHUNK];
  float pcm[CHUNK];
  size_t got;
  long chunks = 0;
  struct stat st;
  time_t ctx_mtime = context && !stat(context, &st) ? st.st_mtime : 0;
  while ((got = fread(raw, 2, CHUNK, stdin)) > 0) {
    if (context && ++chunks % 50 == 0 && !stat(context, &st) && st.st_mtime != ctx_mtime) {   /* every 5 s */
      ctx_mtime = st.st_mtime;
      load_context(e, context);
    }
    for (size_t i = 0; i < got; ++i) pcm[i] = raw[i] / 32768.0f;
    if (arc_stream_push(s, pcm, got)) { fprintf(stderr, "arc: %s\n", arc_last_error()); return 1; }
  }
  arc_stream_finish(s);
  arc_stream_close(s);
  arc_destroy(e);
  return 0;
}
