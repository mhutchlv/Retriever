cmake_minimum_required(VERSION 3.15)
project(playfair C)

# FairPlay key-decryption helper vendored from UxPlay (lib/playfair, GPL-3.0).
# Builds a tiny shared library with a single export: playfair_decrypt().
add_library(playfair SHARED
    playfair.c
    omg_hax.c
    sap_hash.c
    modified_md5.c
    hand_garble.c)

if(MSVC)
    # The sources are plain C99; silence CRT deprecation noise.
    target_compile_definitions(playfair PRIVATE _CRT_SECURE_NO_WARNINGS)
else()
    target_link_libraries(playfair PRIVATE m)
endif()

set_target_properties(playfair PROPERTIES
    PREFIX ""
    OUTPUT_NAME "playfair"
    C_VISIBILITY_PRESET default)
