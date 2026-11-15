#include "brain.h"
#include <cstdio>
int main(int argc, char ** argv) {
    std::string e = brain_load(argv[1], 2, 1024); if (!e.empty()) { printf("LOAD FAIL %s\n", e.c_str()); return 1; }
    std::vector<BrainMsg> m = { {"system", "You are helpful."}, {"user", "Hello there"} };
    std::string stats, out;
    e = brain_generate(m, 40, 0.6f, [&](const std::string & p) { out += p; return true; }, stats);
    printf("1: err=[%s] stats=%s len=%zu\n", e.c_str(), stats.c_str(), out.size());
    m.push_back({"assistant", out}); m.push_back({"user", "And again?"}); std::string out2;
    e = brain_generate(m, 40, 0.0f, [&](const std::string & p) { out2 += p; return out2.size() < 30; }, stats);
    printf("2: err=[%s] stats=%s len=%zu (prompt tokens should be small: reuse)\n", e.c_str(), stats.c_str(), out2.size());
    brain_free(); return 0;
}
