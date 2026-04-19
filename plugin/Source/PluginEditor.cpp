#include "PluginProcessor.h"
#include "PluginEditor.h"

LydbolgeLabEditor::LydbolgeLabEditor (LydbolgeLabProcessor& p)
    : AudioProcessorEditor (&p), audioProcessor (p)
{
    masterVolSlider.setSliderStyle(juce::Slider::LinearHorizontal);
    masterVolSlider.setTextBoxStyle(juce::Slider::TextBoxRight, false, 50, 20);
    addAndMakeVisible(masterVolSlider);

    volAttachment = std::make_unique<juce::AudioProcessorValueTreeState::SliderAttachment>(
        audioProcessor.apvts, "masterVol", masterVolSlider);

    setSize (600, 400);
}

LydbolgeLabEditor::~LydbolgeLabEditor() {}

void LydbolgeLabEditor::paint (juce::Graphics& g)
{
    g.fillAll (juce::Colour(0xff1a1a1a));
    g.setColour (juce::Colour(0xffff7b00));
    g.setFont (24.0f);
    g.drawFittedText ("LYDBOLGE-LAB (VST3 & Standalone)", getLocalBounds().reduced(20).removeFromTop(40), juce::Justification::left, 1);
    
    g.setFont(14.0f);
    g.setColour(juce::Colours::white);
    g.drawText("Master Volum:", 20, 80, 100, 20, juce::Justification::left);
}

void LydbolgeLabEditor::resized()
{
    masterVolSlider.setBounds(120, 80, 300, 20);
}
