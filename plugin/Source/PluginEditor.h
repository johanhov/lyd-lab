#pragma once
#include <JuceHeader.h>
#include "PluginProcessor.h"

class LydbolgeLabEditor : public juce::AudioProcessorEditor
{
public:
    LydbolgeLabEditor (LydbolgeLabProcessor&);
    ~LydbolgeLabEditor() override;

    void paint (juce::Graphics&) override;
    void resized() override;

private:
    LydbolgeLabProcessor& audioProcessor;
    
    juce::Slider masterVolSlider;
    std::unique_ptr<juce::AudioProcessorValueTreeState::SliderAttachment> volAttachment;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (LydbolgeLabEditor)
};
